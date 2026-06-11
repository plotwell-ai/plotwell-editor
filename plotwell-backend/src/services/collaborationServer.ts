import { WebSocketServer, WebSocket as WSWebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Awareness } from 'y-protocols/awareness';
import { prosemirrorJSONToYXmlFragment, yDocToProsemirrorJSON } from 'y-prosemirror';
import { Schema } from 'prosemirror-model';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import type { Server } from 'http';
import { createScriptVersionSnapshot } from './scriptVersionService';
import { detectWholeDocumentDuplication } from '../utils/scriptContentGuard';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const jwks = jwksClient({
  jwksUri: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000,
  timeout: 30000,
  requestHeaders: {
    apikey: SUPABASE_SERVICE_ROLE_KEY || '',
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY || ''}`,
    'User-Agent': 'plotwell-backend',
  },
});

interface CollaborationRoom {
  doc: Y.Doc;
  awareness: Awareness;
  clients: Set<ExtendedWebSocket>;
  projectId: string;
  documentType: string;
  documentId: string;
  lastSaved: number;
}

interface ExtendedWebSocket extends WSWebSocket {
  userId?: string;
  projectId?: string;
  documentType?: string;
  documentId?: string;
  roomKey?: string;
  isAlive?: boolean;
  messageCount?: number;
  messageWindowStart?: number;
  awarenessClientIds?: Set<number>;
}

const rooms = new Map<string, CollaborationRoom>();
const wsClients = new Set<ExtendedWebSocket>();
const saveTimeouts = new Map<string, NodeJS.Timeout>();
const versionSnapshotTimes = new Map<string, number>();

const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 3;
const AUTO_VERSION_INTERVAL_MS = 60 * 1000;

const screenplaySchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    sceneHeading: { group: 'block', content: 'text*', defining: true, attrs: { id: { default: null } } },
    action: { group: 'block', content: 'text*', defining: true },
    character: { group: 'block', content: 'text*', defining: true },
    dialogue: { group: 'block', content: 'text*', defining: true },
    parenthetical: { group: 'block', content: 'text*', defining: true },
    transition: { group: 'block', content: 'text*', defining: true },
    pageBreak: { group: 'block', atom: true },
    text: { group: 'inline' },
  },
  marks: {
    bold: {},
    italic: {},
    underline: {},
  },
});

export function encodeYjsStateForDatabase(state: Uint8Array): string {
  return `\\x${Buffer.from(state).toString('hex')}`;
}

export function decodeYjsStateFromDatabase(value: any): Uint8Array | null {
  if (!value) return null;

  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  if (value?.type === 'Buffer' && Array.isArray(value.data)) return new Uint8Array(value.data);

  if (typeof value === 'string') {
    if (value.startsWith('\\x')) {
      return new Uint8Array(Buffer.from(value.slice(2), 'hex'));
    }

    if (value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return new Uint8Array(parsed);
      } catch { /* fall through to base64 */ }
    }

    return new Uint8Array(Buffer.from(value, 'base64'));
  }

  return null;
}

export function isValidYjsState(value: any): boolean {
  const state = decodeYjsStateFromDatabase(value);
  if (!state || state.length === 0) return false;

  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    doc.destroy();
    return true;
  } catch {
    return false;
  }
}

export function isEmptyProseMirrorDoc(content: any): boolean {
  if (!content) return true;

  if (typeof content.text === 'string' && content.text.trim().length > 0) {
    return false;
  }

  if (Array.isArray(content.content)) {
    return content.content.every(child => isEmptyProseMirrorDoc(child));
  }

  return true;
}

function getProseMirrorText(content: any): string {
  if (!content) return '';

  if (typeof content.text === 'string') {
    return content.text;
  }

  if (Array.isArray(content.content)) {
    return content.content.map(child => getProseMirrorText(child)).join('\n');
  }

  return '';
}

export function isEmptyYjsProsemirrorState(value: any): boolean {
  const state = decodeYjsStateFromDatabase(value);
  if (!state || state.length === 0) return true;

  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return isEmptyProseMirrorDoc(yDocToProsemirrorJSON(doc));
  } catch {
    return true;
  } finally {
    doc.destroy();
  }
}

export async function invalidateCollaborationDocumentState(
  projectId: string,
  documentType: string,
  documentId: string
) {
  const roomKey = `${projectId}:${documentType}:${documentId}`;
  const existingTimeout = saveTimeouts.get(roomKey);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
    saveTimeouts.delete(roomKey);
  }

  const room = rooms.get(roomKey);
  if (room) {
    for (const client of room.clients) {
      client.close(1012, 'Collaboration document was reset');
      wsClients.delete(client);
    }
    room.awareness.destroy();
    room.doc.destroy();
    rooms.delete(roomKey);
  }

  versionSnapshotTimes.delete(roomKey);

  await supabase
    .from('collaboration_documents')
    .update({
      yjs_state: null,
      yjs_vector_clock: {},
      collaborator_count: 0,
      last_updated: new Date().toISOString(),
    })
    .eq('project_id', projectId)
    .eq('document_type', documentType)
    .eq('document_id', documentId);
}

export function getCollaborationRoomClientCount(
  projectId: string,
  documentType: string,
  documentId: string
): number {
  return rooms.get(`${projectId}:${documentType}:${documentId}`)?.clients.size || 0;
}

export function hasActiveCollaborationRoom(
  projectId: string,
  documentType: string,
  documentId: string
): boolean {
  return rooms.has(`${projectId}:${documentType}:${documentId}`);
}

export function getActiveScriptRoomContent(
  projectId: string,
  documentId: string
): any | null {
  const room = rooms.get(`${projectId}:script:${documentId}`);
  if (!room) return null;

  try {
    return yDocToProsemirrorJSON(room.doc);
  } catch (error) {
    console.error('Error reading active script collaboration room content:', {
      projectId,
      documentId,
      error,
    });
    return null;
  }
}

export async function getCollaborationRoomBootstrapState(
  projectId: string,
  documentType: string,
  documentId: string
): Promise<{ yjsState: string; content: any | null; activeClientCount: number }> {
  const room = await getOrCreateCollaborationRoom(projectId, documentType, documentId);
  const state = Y.encodeStateAsUpdate(room.doc);
  const content = documentType === 'script' ? yDocToProsemirrorJSON(room.doc) : null;

  return {
    yjsState: encodeYjsStateForDatabase(state),
    content,
    activeClientCount: room.clients.size,
  };
}

export function replaceActiveScriptRoomContent(
  projectId: string,
  documentId: string,
  content: any
): boolean {
  if (!content || isEmptyProseMirrorDoc(content)) return false;

  const room = rooms.get(`${projectId}:script:${documentId}`);
  if (!room) return false;

  try {
    const fragment = room.doc.getXmlFragment('prosemirror');
    room.doc.transact(() => {
      if (fragment.length > 0) {
        fragment.delete(0, fragment.length);
      }
      prosemirrorJSONToYXmlFragment(screenplaySchema, content, fragment);
    }, 'rest-script-save');

    scheduleDocumentSave(room);
    return true;
  } catch (error) {
    console.error('Error replacing active script collaboration room content:', {
      projectId,
      documentId,
      error,
    });
    return false;
  }
}

export async function flushActiveScriptRoomToDatabase(
  projectId: string,
  documentId: string,
  options: {
    userId?: string | null;
    changeSummary?: string;
    createVersion?: boolean;
  } = {}
): Promise<{ flushed: boolean; content: any | null }> {
  const room = rooms.get(`${projectId}:script:${documentId}`);
  if (!room) return { flushed: false, content: null };

  await saveDocumentState(room);
  const content = getActiveScriptRoomContent(projectId, documentId);

  if (options.createVersion) {
    await createScriptVersionSnapshot(supabase, {
      scriptId: documentId,
      userId: options.userId || null,
      changeSummary: options.changeSummary || 'Manual save',
      skipIfUnchanged: true,
    });
  }

  return { flushed: true, content };
}

export async function applyScriptContentToActiveRoom(
  projectId: string,
  documentId: string,
  content: any,
  options: {
    userId?: string | null;
    changeSummary?: string;
    createVersion?: boolean;
    flush?: boolean;
  } = {}
): Promise<{ appliedToRoom: boolean; content: any | null }> {
  const appliedToRoom = replaceActiveScriptRoomContent(projectId, documentId, content);
  if (!appliedToRoom) return { appliedToRoom: false, content: null };

  if (options.flush !== false || options.createVersion) {
    const flushed = await flushActiveScriptRoomToDatabase(projectId, documentId, {
      userId: options.userId,
      changeSummary: options.changeSummary,
      createVersion: options.createVersion,
    });
    return { appliedToRoom: true, content: flushed.content };
  }

  return { appliedToRoom: true, content: getActiveScriptRoomContent(projectId, documentId) };
}

export async function reconcileActiveScriptRoomFromDatabase(
  projectId: string,
  documentId: string
): Promise<boolean> {
  const roomKey = `${projectId}:script:${documentId}`;
  const room = rooms.get(roomKey);
  if (!room) return false;

  const { data: script, error } = await supabase
    .from('scripts')
    .select('content')
    .eq('id', documentId)
    .eq('project_id', projectId)
    .maybeSingle();

  if (error) {
    console.error('Error loading script for collaboration room reconciliation:', error);
    return false;
  }

  if (!script?.content || isEmptyProseMirrorDoc(script.content)) return false;

  const roomContent = yDocToProsemirrorJSON(room.doc);
  const roomText = getProseMirrorText(roomContent).trim();
  const databaseText = getProseMirrorText(script.content).trim();

  if (databaseText.length === 0) return false;

  const roomLooksStale =
    roomText.length === 0 ||
    databaseText.includes(roomText) ||
    databaseText.length > roomText.length + 20;

  if (!roomLooksStale) return false;

  console.warn('Repairing stale active script collaboration room from database:', {
    projectId,
    documentId,
    roomTextLength: roomText.length,
    databaseTextLength: databaseText.length,
  });

  await invalidateCollaborationDocumentState(projectId, 'script', documentId);
  return true;
}

export function setupCollaborationServer(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer });

  setInterval(() => {
    wss.clients.forEach((ws: ExtendedWebSocket) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  setInterval(() => {
    for (const [roomKey, room] of rooms.entries()) {
      if (room.clients.size === 0) {
        saveDocumentState(room);
        rooms.delete(roomKey);
      }
    }
  }, 5 * 60 * 1000);

  wss.on('connection', async (ws: ExtendedWebSocket, request) => {
    try {
      const auth = await authenticateConnection(request.url || '');
      if (!auth) {
        ws.close(1008, 'Access denied');
        return;
      }

      ws.isAlive = true;
      ws.messageCount = 0;
      ws.messageWindowStart = Date.now();
      ws.userId = auth.userId;
      ws.projectId = auth.projectId;
      ws.documentType = auth.documentType;
      ws.documentId = auth.documentId;
      wsClients.add(ws);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (message: Buffer) => {
        try {
          const now = Date.now();
          if (now - (ws.messageWindowStart || 0) > 10000) {
            ws.messageCount = 0;
            ws.messageWindowStart = now;
          }

          ws.messageCount = (ws.messageCount || 0) + 1;
          if (ws.messageCount > 300) {
            ws.close(1008, 'Rate limit exceeded');
            return;
          }

          handleMessage(ws, new Uint8Array(message));
        } catch (error) {
          console.warn('Ignoring malformed collaboration message:', error);
        }
      });

      ws.on('close', () => handleDisconnect(ws));
      ws.on('error', (error) => {
        console.error('Collaboration websocket error:', error);
        handleDisconnect(ws);
      });

      await joinRoom(ws, auth.projectId, auth.documentType, auth.documentId);
    } catch (error) {
      console.error('Collaboration connection error:', error);
      ws.close(1011, 'Server error');
    }
  });

  return wss;
}

async function authenticateConnection(rawUrl: string) {
  const url = new URL(rawUrl, 'http://localhost');
  if (!url.pathname.startsWith('/collaboration/')) return null;

  const token = url.searchParams.get('token');
  const projectId = url.searchParams.get('projectId');
  const documentType = url.searchParams.get('documentType');
  const documentId = url.searchParams.get('documentId');

  if (!token || !projectId || !documentType || !documentId) return null;
  if (!['script', 'concept', 'character', 'location', 'document'].includes(documentType)) return null;

  const userId = await verifySupabaseAccessToken(token);
  if (!userId) return null;

  const { data: project } = await supabase
    .from('projects')
    .select('user_id')
    .eq('id', projectId)
    .single();

  if (!project) return null;
  if (project.user_id === userId) {
    return { userId, projectId, documentType, documentId };
  }

  const { data: collaborator } = await supabase
    .from('project_collaborators')
    .select('role, status, permissions')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (!collaborator) return null;
  const canEdit = collaborator.permissions?.can_edit_content !== false
    && ['owner', 'admin', 'editor'].includes(collaborator.role);

  return canEdit ? { userId, projectId, documentType, documentId } : null;
}

async function verifySupabaseAccessToken(token: string): Promise<string | null> {
  const decoded = jwt.decode(token, { complete: true }) as jwt.Jwt | null;
  const alg = decoded?.header?.alg;
  const kid = decoded?.header?.kid;

  try {
    let payload: string | jwt.JwtPayload;

    if (alg === 'HS256' && SUPABASE_JWT_SECRET) {
      payload = jwt.verify(token, SUPABASE_JWT_SECRET, { algorithms: ['HS256'] });
    } else if ((alg === 'ES256' || alg === 'RS256') && kid) {
      const key = await jwks.getSigningKey(kid);
      payload = jwt.verify(token, key.getPublicKey(), { algorithms: [alg] });
    } else {
      return await verifyTokenWithSupabaseAuth(token);
    }

    return typeof payload === 'string' ? null : payload.sub || null;
  } catch (error: any) {
    if (error?.name === 'TokenExpiredError') {
      return null;
    }

    console.warn('JWT verification via local keys failed, falling back to Supabase Auth:', error.message);
    return verifyTokenWithSupabaseAuth(token);
  }
}

async function verifyTokenWithSupabaseAuth(token: string): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user?.id) {
    if (error && !String(error.message).includes('expired')) {
      console.warn('Supabase Auth token verification failed:', error.message);
    }
    return null;
  }

  return data.user.id;
}

async function getOrCreateCollaborationRoom(
  projectId: string,
  documentType: string,
  documentId: string
): Promise<CollaborationRoom> {
  const roomKey = `${projectId}:${documentType}:${documentId}`;
  let room = rooms.get(roomKey);

  if (room) return room;

  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  room = { doc, awareness, clients: new Set(), projectId, documentType, documentId, lastSaved: Date.now() };
  rooms.set(roomKey, room);

  await loadDocumentState(room);
  await seedScriptRoomFromDatabase(room);

  doc.on('update', (update: Uint8Array, origin: any) => {
    scheduleDocumentSave(room!);
    broadcastSyncUpdate(room!, update, origin as ExtendedWebSocket | undefined);
  });

  awareness.on('update', ({ added, updated, removed }: any, origin: any) => {
    const changedClients = added.concat(updated).concat(removed);
    if (origin?.awarenessClientIds) {
      for (const clientId of added.concat(updated)) {
        origin.awarenessClientIds.add(clientId);
      }
      for (const clientId of removed) {
        origin.awarenessClientIds.delete(clientId);
      }
    }
    broadcastAwareness(room!, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients), origin as ExtendedWebSocket | undefined);
  });

  return room;
}

async function joinRoom(ws: ExtendedWebSocket, projectId: string, documentType: string, documentId: string) {
  const roomKey = `${projectId}:${documentType}:${documentId}`;
  const room = await getOrCreateCollaborationRoom(projectId, documentType, documentId);

  room.clients.add(ws);
  ws.roomKey = roomKey;
  ws.awarenessClientIds = new Set();

  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, messageSync);
  syncProtocol.writeSyncStep1(syncEncoder, room.doc);
  ws.send(encoding.toUint8Array(syncEncoder));

  // Proactively send the current room state. The y-websocket client only marks
  // itself as synced after receiving SyncStep2; relying only on the step1
  // roundtrip can leave slow/new clients visually stuck in "syncing".
  const stateEncoder = encoding.createEncoder();
  encoding.writeVarUint(stateEncoder, messageSync);
  syncProtocol.writeSyncStep2(stateEncoder, room.doc);
  ws.send(encoding.toUint8Array(stateEncoder));

  const awarenessStates = Array.from(room.awareness.getStates().keys());
  if (awarenessStates.length > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, messageAwareness);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, awarenessStates)
    );
    ws.send(encoding.toUint8Array(awarenessEncoder));
  }

  await updateUserPresence(ws.userId!, projectId, documentType, documentId, 'online');
}

async function seedScriptRoomFromDatabase(room: CollaborationRoom) {
  if (room.documentType !== 'script') return;

  const currentContent = yDocToProsemirrorJSON(room.doc);
  if (!isEmptyProseMirrorDoc(currentContent)) return;

  const { data: script, error } = await supabase
    .from('scripts')
    .select('content')
    .eq('id', room.documentId)
    .eq('project_id', room.projectId)
    .maybeSingle();

  if (error) {
    console.error('Error loading script content for collaboration room seed:', error);
    return;
  }

  if (!script?.content || isEmptyProseMirrorDoc(script.content)) return;

  try {
    const fragment = room.doc.getXmlFragment('prosemirror');
    prosemirrorJSONToYXmlFragment(screenplaySchema, script.content, fragment);
  } catch (error) {
    console.error('Error seeding collaboration room from script content:', error);
  }
}

function handleMessage(ws: ExtendedWebSocket, message: Uint8Array) {
  if (!ws.roomKey) return;
  const room = rooms.get(ws.roomKey);
  if (!room) return;

  const decoder = decoding.createDecoder(message);
  const encoder = encoding.createEncoder();
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case messageSync:
      encoding.writeVarUint(encoder, messageSync);
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
      if (encoding.length(encoder) > 1 && ws.readyState === WSWebSocket.OPEN) {
        ws.send(encoding.toUint8Array(encoder));
      }
      break;

    case messageAwareness:
      awarenessProtocol.applyAwarenessUpdate(
        room.awareness,
        decoding.readVarUint8Array(decoder),
        ws
      );
      break;

    case messageQueryAwareness:
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(room.awareness.getStates().keys()))
      );
      ws.send(encoding.toUint8Array(encoder));
      break;

    default:
      console.warn('Unknown collaboration message type:', messageType);
  }
}

function handleDisconnect(ws: ExtendedWebSocket) {
  wsClients.delete(ws);
  if (!ws.roomKey) return;

  const room = rooms.get(ws.roomKey);
  if (!room) return;

  room.clients.delete(ws);
  const awarenessClientIds = Array.from(ws.awarenessClientIds || []);
  if (awarenessClientIds.length > 0) {
    awarenessProtocol.removeAwarenessStates(room.awareness, awarenessClientIds, ws);
  }

  if (room.clients.size === 0) {
    saveDocumentState(room);
    rooms.delete(ws.roomKey);
  }

  if (ws.userId && ws.projectId) {
    updateUserPresence(ws.userId, ws.projectId, ws.documentType || '', ws.documentId || '', 'offline');
  }
}

function broadcastSyncUpdate(room: CollaborationRoom, update: Uint8Array, exclude?: ExtendedWebSocket) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  broadcastToRoom(room, encoding.toUint8Array(encoder), exclude);
}

function broadcastAwareness(room: CollaborationRoom, update: Uint8Array, exclude?: ExtendedWebSocket) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageAwareness);
  encoding.writeVarUint8Array(encoder, update);
  broadcastToRoom(room, encoding.toUint8Array(encoder), exclude);
}

function broadcastToRoom(room: CollaborationRoom, message: Uint8Array, exclude?: ExtendedWebSocket) {
  room.clients.forEach(client => {
    if (client !== exclude && client.readyState === WSWebSocket.OPEN) {
      client.send(message);
    }
  });
}

async function loadDocumentState(room: CollaborationRoom) {
  // Scripts are persisted through scripts.content. Keeping a durable Yjs blob
  // for scripts caused stale/duplicated content to win on refresh.
  if (room.documentType === 'script') return;

  const { data, error } = await supabase
    .from('collaboration_documents')
    .select('yjs_state')
    .eq('project_id', room.projectId)
    .eq('document_type', room.documentType)
    .eq('document_id', room.documentId)
    .maybeSingle();

  if (error) {
    console.error('Error loading collaboration state:', error);
    return;
  }

  if (data?.yjs_state) {
    const state = decodeYjsStateFromDatabase(data.yjs_state);
    if (!state) return;

    try {
      Y.applyUpdate(room.doc, state);
    } catch (error) {
      console.warn('Ignoring corrupt collaboration state and resetting it:', {
        projectId: room.projectId,
        documentType: room.documentType,
        documentId: room.documentId,
        error,
      });

      await supabase
        .from('collaboration_documents')
        .update({ yjs_state: null, yjs_vector_clock: {}, last_updated: new Date().toISOString() })
        .eq('project_id', room.projectId)
        .eq('document_type', room.documentType)
        .eq('document_id', room.documentId);
    }
  }
}

function scheduleDocumentSave(room: CollaborationRoom) {
  const roomKey = `${room.projectId}:${room.documentType}:${room.documentId}`;
  const existingTimeout = saveTimeouts.get(roomKey);
  if (existingTimeout) clearTimeout(existingTimeout);

  const timeout = setTimeout(() => {
    saveDocumentState(room);
    saveTimeouts.delete(roomKey);
  }, 2000);
  saveTimeouts.set(roomKey, timeout);
}

async function saveDocumentState(room: CollaborationRoom) {
  try {
    let scriptContent: any = null;

    if (room.documentType === 'script') {
      scriptContent = yDocToProsemirrorJSON(room.doc);

      const { data: existingScript, error: existingScriptError } = await supabase
        .from('scripts')
        .select('content')
        .eq('id', room.documentId)
        .eq('project_id', room.projectId)
        .maybeSingle();

      if (existingScriptError) {
        console.error('Error loading existing script before collaborative save:', existingScriptError);
        return;
      }

      const duplication = detectWholeDocumentDuplication(existingScript?.content, scriptContent);
      if (duplication.duplicated && existingScript?.content) {
        console.warn('Blocked duplicated collaborative script content save:', {
          projectId: room.projectId,
          documentId: room.documentId,
          repeatCount: duplication.repeatCount,
        });

        const fragment = room.doc.getXmlFragment('prosemirror');
        room.doc.transact(() => {
          if (fragment.length > 0) {
            fragment.delete(0, fragment.length);
          }
          prosemirrorJSONToYXmlFragment(screenplaySchema, existingScript.content, fragment);
        }, 'duplicate-content-guard');

        scriptContent = existingScript.content;
      }

      const { error: scriptUpdateError } = await supabase
        .from('scripts')
        .update({ content: scriptContent, updated_at: new Date().toISOString() })
        .eq('id', room.documentId)
        .eq('project_id', room.projectId);

      if (scriptUpdateError) {
        console.error('Error saving collaborative script content:', scriptUpdateError);
        return;
      }
    }

    const state = Y.encodeStateAsUpdate(room.doc);
    const yjsState = room.documentType === 'script'
      ? null
      : encodeYjsStateForDatabase(state);

    const { error } = await supabase
      .from('collaboration_documents')
      .upsert({
        project_id: room.projectId,
        document_type: room.documentType,
        document_id: room.documentId,
        yjs_state: yjsState,
        yjs_vector_clock: {},
        collaborator_count: room.clients.size,
        last_updated: new Date().toISOString(),
      }, {
        onConflict: 'project_id,document_type,document_id',
      });

    if (error) console.error('Error saving collaboration state:', error);

    if (room.documentType === 'script') {
      const roomKey = `${room.projectId}:${room.documentType}:${room.documentId}`;
      const lastSnapshotAt = versionSnapshotTimes.get(roomKey) || 0;
      const shouldCreateVersion = Date.now() - lastSnapshotAt >= AUTO_VERSION_INTERVAL_MS;

      if (shouldCreateVersion) {
        const firstActiveUser = Array.from(room.clients).find(client => client.userId)?.userId || null;
        await createScriptVersionSnapshot(supabase, {
          scriptId: room.documentId,
          userId: firstActiveUser,
          changeSummary: 'Collaborative auto-save',
          skipIfUnchanged: true,
        });
        versionSnapshotTimes.set(roomKey, Date.now());
      }
    }

    room.lastSaved = Date.now();
  } catch (error) {
    console.error('Error in saveDocumentState:', error);
  }
}

async function updateUserPresence(userId: string, projectId: string, documentType: string, documentId: string, status: string) {
  try {
    await supabase
      .from('user_presence')
      .upsert({
        user_id: userId,
        project_id: projectId,
        document_type: documentType,
        document_id: documentId,
        status,
        last_seen: new Date().toISOString(),
      }, {
        onConflict: 'user_id,project_id',
      });
  } catch (error) {
    console.error('Error updating user presence:', error);
  }
}

export function closeCollaborationServer() {
  rooms.forEach(room => saveDocumentState(room));
  wsClients.forEach(ws => ws.close(1001, 'Server shutting down'));
  rooms.clear();
  wsClients.clear();
}
