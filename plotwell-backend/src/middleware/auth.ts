import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

// Ensure env vars are loaded
dotenv.config();

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Initialize Supabase client lazily
let supabaseClient: ReturnType<typeof createClient> | null = null;
const getSupabaseClient = () => {
  if (!supabaseClient && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabaseClient;
};

// JWKS client for ECC key verification
const client = jwksClient({
  jwksUri: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600000, // 10 minutes
  timeout: 30000,
  requestHeaders: {
    'apikey': SUPABASE_SERVICE_ROLE_KEY || '',
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY || ''}`,
    'User-Agent': 'plotwell-backend'
  }
});

export function getUserId(req: Request): string | null {
  return req.user?.id || null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.error(`Auth error: Missing or invalid Authorization header for ${req.method} ${req.path}`);
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }
  
  if (!SUPABASE_JWT_SECRET) {
    console.error("Auth error: SUPABASE_JWT_SECRET not configured");
    return res.status(500).json({ error: "Server configuration error" });
  }
  
  const token = authHeader.replace("Bearer ", "");
  
  // Decode token header to determine algorithm
  const decoded = jwt.decode(token, { complete: true }) as jwt.Jwt | null;
  if (!decoded || !decoded.header) {
    console.error("Auth error: Invalid JWT format");
    return res.status(401).json({ error: "Invalid token format" });
  }
  
  const { alg, kid } = decoded.header;
  
  try {
    let payload;
    
    if (alg === 'ES256' && kid) {
      // ES256 tokens - verify signature using JWKS
      try {
        const key = await client.getSigningKey(kid);
        const signingKey = key.getPublicKey();
        payload = jwt.verify(token, signingKey, { algorithms: ['ES256'] });
      } catch (jwksError: any) {
        // If JWKS fails (e.g., network issue), log and reject the token
        console.error('ES256 JWKS verification failed:', jwksError.message);
        throw new Error('Token signature verification failed');
      }
      
    } else if (alg === 'HS256') {
      // Legacy tokens - use shared secret
      payload = jwt.verify(token, SUPABASE_JWT_SECRET!, { algorithms: ['HS256'] });
      
    } else {
      throw new Error(`Unsupported algorithm: ${alg}`);
    }
    
    // Attach user info to req
    const sub = (payload as jwt.JwtPayload).sub;
    if (!sub) {
      return res.status(401).json({ error: "Invalid token: missing user ID" });
    }
    req.user = {
      id: sub, // Supabase uses 'sub' for user ID
      ...payload
    };
    next();
    
  } catch (err) {
    console.error("Auth error: Invalid or expired token:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Middleware to check if user has access to a project (read access)
 * Allows access if user is:
 * 1. The project owner, OR
 * 2. An active collaborator (viewer, editor, or admin role)
 *
 * For write operations, use checkWritePermissions from pricingMiddleware instead.
 */
export async function checkProjectAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Extract project_id from query, body, or params
    const projectId = req.query.project_id || req.body?.project_id || req.params.project_id;

    if (!projectId) {
      return res.status(400).json({ error: 'Project ID is required' });
    }

    const supabase = getSupabaseClient();
    if (!supabase) {
      console.error('Supabase client not initialized');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Check if user owns this project
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .single();

    if (projectError) {
      if (projectError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Project not found' });
      }
      console.error('Error checking project ownership:', projectError);
      return res.status(500).json({ error: 'Failed to verify project access' });
    }

    // Owner has full access
    if (project.user_id === userId) {
      return next();
    }

    // Check if user is a collaborator
    const { data: collaborator, error: collabError } = await supabase
      .from('project_collaborators')
      .select('role, status')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .single();

    if (collabError || !collaborator) {
      return res.status(403).json({ error: 'Access denied - not authorized for this project' });
    }

    // Collaborator must have active status
    if (collaborator.status !== 'active') {
      return res.status(403).json({ error: 'Access denied - collaboration is not active' });
    }

    // All roles (viewer, editor, admin) have read access
    // Store the role in request for downstream middleware/handlers
    req.collaboratorRole = collaborator.role as string;

    next();
  } catch (error) {
    console.error('Error in checkProjectAccess:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Factory function to create middleware that checks project access by record ID.
 * Looks up the record in the specified table, gets its project_id, then checks access.
 *
 * @param tableName - The database table to look up (e.g., 'characters', 'locations')
 * @param requireWriteAccess - If true, blocks viewers (only editor/admin/owner allowed)
 */
export function checkProjectAccessByRecordId(tableName: string, requireWriteAccess: boolean = false) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const recordId = req.params.id;

      if (!recordId) {
        return res.status(400).json({ error: 'Record ID is required' });
      }

      const supabase = getSupabaseClient();
      if (!supabase) {
        console.error('Supabase client not initialized');
        return res.status(500).json({ error: 'Server configuration error' });
      }

      // Look up the record to get its project_id
      const { data: record, error: recordError } = await supabase
        .from(tableName)
        .select('project_id')
        .eq('id', recordId)
        .single();

      if (recordError) {
        if (recordError.code === 'PGRST116') {
          return res.status(404).json({ error: `${tableName.slice(0, -1)} not found` });
        }
        console.error(`Error fetching ${tableName} record:`, recordError);
        return res.status(500).json({ error: `Failed to fetch ${tableName.slice(0, -1)}` });
      }

      const projectId = record.project_id;

      // Check if user owns this project
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .select('user_id')
        .eq('id', projectId)
        .single();

      if (projectError) {
        if (projectError.code === 'PGRST116') {
          return res.status(404).json({ error: 'Project not found' });
        }
        console.error('Error checking project ownership:', projectError);
        return res.status(500).json({ error: 'Failed to verify project access' });
      }

      // Owner has full access
      if (project.user_id === userId) {
        return next();
      }

      // Check if user is a collaborator
      const { data: collaborator, error: collabError } = await supabase
        .from('project_collaborators')
        .select('role, status')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .single();

      if (collabError || !collaborator) {
        return res.status(403).json({ error: 'Access denied - not authorized for this project' });
      }

      // Collaborator must have active status
      if (collaborator.status !== 'active') {
        return res.status(403).json({ error: 'Access denied - collaboration is not active' });
      }

      // Check write access requirement
      if (requireWriteAccess && collaborator.role === 'viewer') {
        return res.status(403).json({
          error: 'Read-only access - viewers cannot make changes',
          role: 'viewer',
          action_required: 'contact_owner_for_permissions'
        });
      }

      // Store the role and project_id in request for downstream handlers
      req.collaboratorRole = collaborator.role as string;
      req.projectId = projectId as string;

      next();
    } catch (error) {
      console.error(`Error in checkProjectAccessByRecordId(${tableName}):`, error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}