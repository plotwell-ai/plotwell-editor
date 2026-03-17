import { Router, Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAuth, checkProjectAccess } from "../middleware/auth";
import { extractUserId } from "../middleware/pricingMiddleware";
import dotenv from "dotenv";

dotenv.config();

const router = Router();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Middleware to check access to a conversation by its ID.
 * Verifies user is project owner OR active collaborator.
 * Also supports write access restriction (blocks viewers).
 */
const checkConversationAccess = (requireWriteAccess: boolean = false) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
      }

      const conversationId = req.params.conversation_id;
      if (!conversationId) {
        return res.status(400).json({ error: "Conversation ID is required" });
      }

      // Get conversation's project_id
      const { data: conversation, error: convError } = await supabase
        .from("conversations")
        .select("project_id")
        .eq("id", conversationId)
        .single();

      if (convError || !conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Check if user owns the project
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("user_id")
        .eq("id", conversation.project_id)
        .single();

      if (projectError || !project) {
        return res.status(404).json({ error: "Project not found" });
      }

      // Owner has full access
      if (project.user_id === userId) {
        req.projectId = conversation.project_id;
        return next();
      }

      // Check if user is a collaborator
      const { data: collaborator, error: collabError } = await supabase
        .from("project_collaborators")
        .select("role, status")
        .eq("project_id", conversation.project_id)
        .eq("user_id", userId)
        .single();

      if (collabError || !collaborator || collaborator.status !== "active") {
        return res.status(403).json({ error: "Access denied - not authorized for this project" });
      }

      // Check write access requirement
      if (requireWriteAccess && collaborator.role === "viewer") {
        return res.status(403).json({
          error: "Read-only access - viewers cannot make changes",
          role: "viewer"
        });
      }

      req.collaboratorRole = collaborator.role;
      req.projectId = conversation.project_id;
      next();
    } catch (error) {
      console.error("Error in checkConversationAccess:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  };
};

// Get all conversations for a project
router.get("/", requireAuth, extractUserId, checkProjectAccess, async (req, res) => {
  const { project_id } = req.query;
  
  if (!project_id) {
    return res.status(400).json({ error: "project_id is required" });
  }

  try {
    const { data: conversations, error } = await supabase
      .from("conversations")
      .select(`
        id,
        title,
        created_at,
        updated_at,
        is_archived,
        conversation_messages(
          id,
          role,
          content,
          created_at
        )
      `)
      .eq("project_id", project_id)
      .eq("is_archived", false)
      .order("updated_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Add message count and preview to each conversation
    const conversationsWithPreview = conversations?.map(conv => ({
      ...conv,
      message_count: conv.conversation_messages?.length || 0,
      last_message: conv.conversation_messages?.length > 0 
        ? conv.conversation_messages[conv.conversation_messages.length - 1]
        : null,
      // Remove full messages from response for performance
      conversation_messages: undefined
    })) || [];

    res.json({ conversations: conversationsWithPreview });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get a specific conversation with messages
router.get("/:conversation_id", requireAuth, extractUserId, checkConversationAccess(false), async (req, res) => {
  const { conversation_id } = req.params;

  try {
    const { data: conversation, error } = await supabase
      .from("conversations")
      .select(`
        id,
        title,
        project_id,
        created_at,
        updated_at,
        conversation_messages(
          id,
          role,
          content,
          attachments,
          created_at,
          token_count,
          model_used,
          user_id
        )
      `)
      .eq("id", conversation_id)
      .single();

    if (error) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    // Sort messages by creation time
    if (conversation.conversation_messages) {
      conversation.conversation_messages.sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );

      // Fetch user data for each message that has a user_id
      const userIds = [...new Set(
        conversation.conversation_messages
          .filter(msg => msg.user_id)
          .map(msg => msg.user_id)
      )];

      if (userIds.length > 0) {
        const { data: users, error: usersError } = await supabase
          .from("users")
          .select("id, full_name, email")
          .in("id", userIds);

        if (!usersError && users) {
          // Create a map of user data
          const userMap = new Map(users.map(u => [u.id, u]));

          // Attach user data to messages
          conversation.conversation_messages = conversation.conversation_messages.map(msg => ({
            ...msg,
            user: msg.user_id ? userMap.get(msg.user_id) : null
          }));
        }
      }
    }

    res.json({ conversation });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create a new conversation
router.post("/", requireAuth, extractUserId, checkProjectAccess, async (req, res) => {
  const { project_id, title = "New conversation" } = req.body;

  if (!project_id) {
    return res.status(400).json({ error: "project_id is required" });
  }

  try {
    const { data: conversation, error } = await supabase
      .from("conversations")
      .insert([{
        project_id,
        title
      }])
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ conversation });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add message to conversation
router.post("/:conversation_id/messages", requireAuth, extractUserId, checkConversationAccess(true), async (req, res) => {
  const { conversation_id } = req.params;
  const { role, content, attachments, token_count, model_used } = req.body;

  if (!role || !content) {
    return res.status(400).json({ error: "role and content are required" });
  }

  if (!["user", "assistant"].includes(role)) {
    return res.status(400).json({ error: "role must be 'user' or 'assistant'" });
  }

  try {
    // Verify conversation exists
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversation_id)
      .single();

    if (convError || !conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    // Use authenticated user ID for user messages
    const userId = role === "user" ? req.user?.id : null;

    // Add message
    const { data: message, error } = await supabase
      .from("conversation_messages")
      .insert([{
        conversation_id,
        role,
        content,
        user_id: userId,
        attachments: attachments || null,
        token_count: token_count || 0,
        model_used: model_used || null
      }])
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ message });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update conversation title
router.patch("/:conversation_id", requireAuth, extractUserId, checkConversationAccess(true), async (req, res) => {
  const { conversation_id } = req.params;
  const { title } = req.body;

  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }

  try {
    const { data: conversation, error } = await supabase
      .from("conversations")
      .update({ title })
      .eq("id", conversation_id)
      .select()
      .single();

    if (error) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json({ conversation });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Archive conversation
router.delete("/:conversation_id", requireAuth, extractUserId, checkConversationAccess(true), async (req, res) => {
  const { conversation_id } = req.params;

  try {
    const { data: conversation, error } = await supabase
      .from("conversations")
      .update({ is_archived: true })
      .eq("id", conversation_id)
      .select()
      .single();

    if (error) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    res.json({ conversation });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Generate conversation title from first message
router.post("/:conversation_id/generate-title", requireAuth, extractUserId, checkConversationAccess(true), async (req, res) => {
  const { conversation_id } = req.params;

  try {
    // Get first user message
    const { data: messages, error } = await supabase
      .from("conversation_messages")
      .select("content")
      .eq("conversation_id", conversation_id)
      .eq("role", "user")
      .order("created_at", { ascending: true })
      .limit(1);

    if (error || !messages?.length) {
      return res.status(404).json({ error: "No messages found" });
    }

    const firstMessage = messages[0].content;
    
    // Generate a title from the first message
    // Take first few words and clean up
    const title = firstMessage
      .split(' ')
      .slice(0, 6)
      .join(' ')
      .replace(/[^\w\s]/g, '')
      .trim() || 'New conversation';

    // Update conversation title
    const { data: conversation, error: updateError } = await supabase
      .from("conversations")
      .update({ title })
      .eq("id", conversation_id)
      .select()
      .single();

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    res.json({ conversation });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;