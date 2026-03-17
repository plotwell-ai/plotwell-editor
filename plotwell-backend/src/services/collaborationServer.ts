import { WebSocketServer, WebSocket as WSWebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import type { Server } from 'http';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Simple awareness implementation
class Awareness {
  private states = new Map();
  public clientID = Math.floor(Math.random() * 0xFFFFFF);
  
  getStates() {
    return this.states;
  }
  
  setLocalState(state: any) {
    this.states.set(this.clientID, state);
  }
  
  updateAwareness(update: any, origin: any) {
    // Simple awareness update handling
  }
}

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
  isAlive?: boolean;
  isAuthenticated?: boolean;
  authTimeout?: ReturnType<typeof setTimeout>;
  messageCount?: number;
  messageWindowStart?: number;
}

const rooms = new Map<string, CollaborationRoom>();
const wsClients = new Set<ExtendedWebSocket>();

// Message types for Y.js protocol
const messageSync = 0;
const messageAwareness = 1;
const messageAuth = 2;

export function setupCollaborationServer(httpServer: Server) {
  const wss = new WebSocketServer({ 
    server: httpServer,
    path: '/collaboration'
  });

  // Heartbeat to detect broken connections
  setInterval(() => {
    wss.clients.forEach((ws: ExtendedWebSocket) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000); // Check every 30 seconds

  // Clean up empty rooms every 5 minutes to prevent memory leaks
  setInterval(() => {
    let cleaned = 0;
    for (const [roomKey, room] of rooms.entries()) {
      if (room.clients.size === 0) {
        saveDocumentState(room);
        rooms.delete(roomKey);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} empty collaboration room(s)`);
    }
  }, 5 * 60 * 1000);

  wss.on('connection', (ws: ExtendedWebSocket, request) => {
    ws.isAlive = true;
    ws.isAuthenticated = false;
    ws.messageCount = 0;
    ws.messageWindowStart = Date.now();
    wsClients.add(ws);

    // Kick unauthenticated connections after 10 seconds
    ws.authTimeout = setTimeout(() => {
      if (!ws.isAuthenticated) {
        ws.close(1008, 'Authentication timeout');
      }
    }, 10000);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (message: Buffer) => {
      try {
        // Rate limit: max 120 messages per 10 seconds per connection
        const now = Date.now();
        if (now - (ws.messageWindowStart || 0) > 10000) {
          ws.messageCount = 0;
          ws.messageWindowStart = now;
        }
        ws.messageCount = (ws.messageCount || 0) + 1;
        if (ws.messageCount > 120) {
          ws.close(1008, 'Rate limit exceeded');
          return;
        }

        await handleMessage(ws, message);
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
        ws.close(1011, 'Server error');
      }
    });

    ws.on('close', () => {
      if (ws.authTimeout) clearTimeout(ws.authTimeout);
      handleDisconnect(ws);
      wsClients.delete(ws);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      if (ws.authTimeout) clearTimeout(ws.authTimeout);
      handleDisconnect(ws);
      wsClients.delete(ws);
    });

    // Send authentication request
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageAuth);
    ws.send(encoding.toUint8Array(encoder));
  });

  return wss;
}

async function handleMessage(ws: ExtendedWebSocket, message: Buffer) {
  const decoder = decoding.createDecoder(message);
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case messageAuth:
      await handleAuth(ws, decoder);
      break;
    case messageSync:
      if (!ws.isAuthenticated) {
        ws.close(1008, 'Not authenticated');
        return;
      }
      handleSync(ws, decoder);
      break;
    case messageAwareness:
      if (!ws.isAuthenticated) {
        ws.close(1008, 'Not authenticated');
        return;
      }
      handleAwareness(ws, decoder);
      break;
    default:
      console.warn('Unknown message type:', messageType);
  }
}

async function handleAuth(ws: ExtendedWebSocket, decoder: decoding.Decoder) {
  try {
    const token = decoding.readVarString(decoder);
    const projectId = decoding.readVarString(decoder);
    const documentType = decoding.readVarString(decoder);
    const documentId = decoding.readVarString(decoder);

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.SUPABASE_JWT_SECRET!) as any;
    const userId = decoded.sub;

    // Check project access
    const { data: collaborator, error } = await supabase
      .from('project_collaborators')
      .select('role, status, permissions')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (error || !collaborator) {
      ws.close(1008, 'Access denied');
      return;
    }

    // Check edit permissions
    if (!collaborator.permissions?.can_edit_content) {
      ws.close(1008, 'No edit permissions');
      return;
    }

    // Mark as authenticated and clear timeout
    ws.isAuthenticated = true;
    if (ws.authTimeout) clearTimeout(ws.authTimeout);

    // Assign connection properties
    ws.userId = userId;
    ws.projectId = projectId;
    ws.documentType = documentType;
    ws.documentId = documentId;

    // Join room
    await joinRoom(ws, projectId, documentType, documentId);

  } catch (error) {
    console.error('Authentication error:', error);
    ws.close(1008, 'Authentication failed');
  }
}

async function joinRoom(ws: ExtendedWebSocket, projectId: string, documentType: string, documentId: string) {
  const roomKey = `${projectId}:${documentType}:${documentId}`;
  
  let room = rooms.get(roomKey);
  if (!room) {
    // Create new room
    const doc = new Y.Doc();
    const awareness = new Awareness();
    
    room = {
      doc,
      awareness,
      clients: new Set(),
      projectId,
      documentType,
      documentId,
      lastSaved: Date.now()
    };
    
    rooms.set(roomKey, room);

    // Load existing document state
    await loadDocumentState(room);
    
    // Setup auto-save
    doc.on('update', () => scheduleDocumentSave(room!));
  }

  // Add client to room
  room.clients.add(ws);

  // Send initial sync message
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeStateAsUpdate(encoder, room.doc);
  ws.send(encoding.toUint8Array(encoder));

  // Send awareness states of other clients
  const awarenessEncoder = encoding.createEncoder();
  encoding.writeVarUint(awarenessEncoder, messageAwareness);
  // Simple awareness update - just send empty array for now
  encoding.writeVarUint8Array(awarenessEncoder, new Uint8Array(0));
  ws.send(encoding.toUint8Array(awarenessEncoder));

  // Update user presence
  await updateUserPresence(ws.userId!, projectId, documentType, documentId, 'online');
}

function handleSync(ws: ExtendedWebSocket, decoder: decoding.Decoder) {
  if (!ws.projectId || !ws.documentType || !ws.documentId) {
    console.warn('Sync message from unauthenticated client');
    return;
  }

  const roomKey = `${ws.projectId}:${ws.documentType}:${ws.documentId}`;
  const room = rooms.get(roomKey);
  
  if (!room) {
    console.warn('Room not found for sync:', roomKey);
    return;
  }

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  
  const syncMessageType = decoding.readVarUint(decoder);
  
  switch (syncMessageType) {
    case syncProtocol.messageYjsSyncStep1:
      syncProtocol.readSyncStep1(decoder, encoder, room.doc);
      break;
    case syncProtocol.messageYjsSyncStep2:
      syncProtocol.readSyncStep2(decoder, room.doc);
      break;
    case syncProtocol.messageYjsUpdate:
      syncProtocol.readUpdate(decoder, room.doc);
      // Broadcast update to other clients
      const updateMessage = encoding.toUint8Array(encoder);
      broadcastToRoom(room, updateMessage, ws);
      break;
  }

  if (encoding.length(encoder) > 1) {
    ws.send(encoding.toUint8Array(encoder));
  }
}

function handleAwareness(ws: ExtendedWebSocket, decoder: decoding.Decoder) {
  if (!ws.projectId || !ws.documentType || !ws.documentId) {
    console.warn('Awareness message from unauthenticated client');
    return;
  }

  const roomKey = `${ws.projectId}:${ws.documentType}:${ws.documentId}`;
  const room = rooms.get(roomKey);
  
  if (!room) {
    console.warn('Room not found for awareness:', roomKey);
    return;
  }

  // Read awareness update
  const awarenessUpdate = decoding.readVarUint8Array(decoder);
  room.awareness.updateAwareness(awarenessUpdate, ws);
  
  // Broadcast awareness update to other clients
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageAwareness);
  encoding.writeVarUint8Array(encoder, awarenessUpdate);
  
  broadcastToRoom(room, encoding.toUint8Array(encoder), ws);
}

function handleDisconnect(ws: ExtendedWebSocket) {
  if (!ws.projectId || !ws.documentType || !ws.documentId) {
    return;
  }

  const roomKey = `${ws.projectId}:${ws.documentType}:${ws.documentId}`;
  const room = rooms.get(roomKey);
  
  if (room) {
    room.clients.delete(ws);

    // Remove awareness state
    room.awareness.getStates().delete(room.awareness.clientID);

    // Clean up empty rooms
    if (room.clients.size === 0) {
      // Save document before cleaning up
      saveDocumentState(room);
      rooms.delete(roomKey);
    }
  }

  // Update user presence to offline
  if (ws.userId && ws.projectId) {
    updateUserPresence(ws.userId, ws.projectId, ws.documentType || '', ws.documentId || '', 'offline');
  }
}

function broadcastToRoom(room: CollaborationRoom, message: Uint8Array, exclude?: ExtendedWebSocket) {
  room.clients.forEach(client => {
    if (client !== exclude && client.readyState === WSWebSocket.OPEN) {
      client.send(message);
    }
  });
}

async function loadDocumentState(room: CollaborationRoom) {
  try {
    const { data, error } = await supabase
      .from('collaboration_documents')
      .select('yjs_state, yjs_vector_clock')
      .eq('project_id', room.projectId)
      .eq('document_type', room.documentType)
      .eq('document_id', room.documentId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error loading document state:', error);
      return;
    }

    if (data?.yjs_state) {
      Y.applyUpdate(room.doc, new Uint8Array(data.yjs_state));
    }
  } catch (error) {
    console.error('Error in loadDocumentState:', error);
  }
}

let saveTimeouts = new Map<string, NodeJS.Timeout>();

function scheduleDocumentSave(room: CollaborationRoom) {
  const roomKey = `${room.projectId}:${room.documentType}:${room.documentId}`;
  
  // Clear existing timeout
  const existingTimeout = saveTimeouts.get(roomKey);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }
  
  // Schedule new save
  const timeout = setTimeout(() => {
    saveDocumentState(room);
    saveTimeouts.delete(roomKey);
  }, 2000); // Save after 2 seconds of inactivity
  
  saveTimeouts.set(roomKey, timeout);
}

async function saveDocumentState(room: CollaborationRoom) {
  try {
    const state = Y.encodeStateAsUpdate(room.doc);
    const vectorClock = room.doc.store.clients;
    
    const { error } = await supabase
      .from('collaboration_documents')
      .upsert({
        project_id: room.projectId,
        document_type: room.documentType,
        document_id: room.documentId,
        yjs_state: Array.from(state),
        yjs_vector_clock: Object.fromEntries(vectorClock),
        collaborator_count: room.clients.size,
        last_updated: new Date().toISOString()
      });

    if (error) {
      console.error('Error saving document state:', error);
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
        last_seen: new Date().toISOString()
      });
  } catch (error) {
    console.error('Error updating user presence:', error);
  }
}

// Y.js sync protocol implementation
const syncProtocol = {
  messageYjsSyncStep1: 0,
  messageYjsSyncStep2: 1,
  messageYjsUpdate: 2,

  writeStateAsUpdate: (encoder: encoding.Encoder, doc: Y.Doc) => {
    encoding.writeVarUint(encoder, syncProtocol.messageYjsUpdate);
    encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc));
  },

  readSyncStep1: (decoder: decoding.Decoder, encoder: encoding.Encoder, doc: Y.Doc) => {
    const stateVector = decoding.readVarUint8Array(decoder);
    const update = Y.encodeStateAsUpdate(doc, stateVector);
    encoding.writeVarUint(encoder, syncProtocol.messageYjsSyncStep2);
    encoding.writeVarUint8Array(encoder, update);
  },

  readSyncStep2: (decoder: decoding.Decoder, doc: Y.Doc) => {
    const update = decoding.readVarUint8Array(decoder);
    Y.applyUpdate(doc, update);
  },

  readUpdate: (decoder: decoding.Decoder, doc: Y.Doc) => {
    const update = decoding.readVarUint8Array(decoder);
    Y.applyUpdate(doc, update);
  }
};

// Cleanup function for graceful shutdown
export function closeCollaborationServer() {
  
  // Save all active documents
  rooms.forEach(room => {
    saveDocumentState(room);
  });
  
  // Close all WebSocket connections
  wsClients.forEach(ws => {
    ws.close(1001, 'Server shutting down');
  });
  
  rooms.clear();
  wsClients.clear();
}