import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middleware/auth";
import { extractUserId, PricingRequest } from "../middleware/pricingMiddleware";
import { PricingService } from '../services/pricingService';
import { validateCommentInput } from "../middleware/inputValidation";

const router = Router();

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Custom middleware for comments feature access (Teams plan and above)
const requireCommentsAccess = async (req: PricingRequest, res: Response, next: any) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }


    // Check comments access for the user (Paid plan required)
    const pricingService = new PricingService(supabase);
    const hasCommentsAccess = await pricingService.hasPaidPlan(userId);

    if (!hasCommentsAccess) {
      return res.status(403).json({
        error: 'Comments feature requires a Pro plan',
        feature: 'comments'
      });
    }

    next();
  } catch (error) {
    console.error('Error checking comments access:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Get comments for content (script or document)
router.get("/:contentType/:contentId", requireAuth, extractUserId, requireCommentsAccess, async (req: Request, res: Response) => {
  try {
    const { contentType, contentId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Validate content type
    if (!["script", "document", "slide"].includes(contentType)) {
      return res.status(400).json({ error: "Invalid content type" });
    }

    // Get project_id from content and verify user has access
    let projectId: string;
    if (contentType === "script") {
      const { data: script, error: scriptError } = await supabase
        .from("scripts")
        .select("project_id")
        .eq("id", contentId)
        .single();
      if (scriptError || !script) {
        return res.status(404).json({ error: "Script not found" });
      }
      projectId = script.project_id;
    } else if (contentType === "slide") {
      // For slides, contentId is in format "documentId:slideId"
      const [documentId] = contentId.split(":");
      const { data: document, error: documentError } = await supabase
        .from("project_documents")
        .select("project_id")
        .eq("id", documentId)
        .single();
      if (documentError || !document) {
        return res.status(404).json({ error: "Document not found for slide" });
      }
      projectId = document.project_id;
    } else {
      const { data: document, error: documentError } = await supabase
        .from("project_documents")
        .select("project_id")
        .eq("id", contentId)
        .single();
      if (documentError || !document) {
        return res.status(404).json({ error: "Document not found" });
      }
      projectId = document.project_id;
    }

    // Verify user has access to the project (owner or collaborator)
    const { data: project } = await supabase
      .from("projects")
      .select("user_id")
      .eq("id", projectId)
      .single();

    const isOwner = project?.user_id === userId;
    let hasAccess = isOwner;

    if (!isOwner) {
      const { data: collaborator } = await supabase
        .from("project_collaborators")
        .select("status")
        .eq("project_id", projectId)
        .eq("user_id", userId)
        .single();
      hasAccess = collaborator?.status === "active";
    }

    if (!hasAccess) {
      return res.status(403).json({ error: "Access denied - not authorized for this project" });
    }

    // Get all comments for this content (both top-level and replies)
    const { data: allComments, error } = await supabase
      .from("comments")
      .select(`
        *,
        user:users!user_id (
          id,
          full_name,
          email,
          avatar_url
        ),
        resolved_by_user:users!resolved_by (
          id,
          full_name
        )
      `)
      .eq("content_type", contentType)
      .eq("content_id", contentId)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching comments:", error);
      return res.status(500).json({ error: "Failed to fetch comments" });
    }

    // Organize comments hierarchically
    const commentMap = new Map();
    const rootComments: any[] = [];

    // First pass: create comment map
    allComments.forEach((comment: any) => {
      commentMap.set(comment.id, { ...comment, replies: [] });
    });

    // Second pass: organize hierarchy (Google Docs style - only 2 levels)
    allComments.forEach((comment: any) => {
      if (comment.parent_comment_id) {
        // This is a reply - find the root parent and add it there
        let rootParent = commentMap.get(comment.parent_comment_id);
        
        // If the parent is also a reply, find its root parent
        while (rootParent && rootParent.parent_comment_id) {
          rootParent = commentMap.get(rootParent.parent_comment_id);
        }
        
        if (rootParent) {
          rootParent.replies.push(commentMap.get(comment.id));
        }
      } else {
        // This is a root comment
        rootComments.push(commentMap.get(comment.id));
      }
    });

    const comments = rootComments;

    // Get reaction counts for each comment (including all nested replies)
    const getAllCommentIds = (comments: any[]): string[] => {
      const ids: string[] = [];
      comments.forEach((comment: any) => {
        ids.push(comment.id);
        if (comment.replies && comment.replies.length > 0) {
          ids.push(...getAllCommentIds(comment.replies));
        }
      });
      return ids;
    };

    const allCommentIds = getAllCommentIds(comments);

    if (allCommentIds.length > 0) {
      const { data: reactions, error: reactionsError } = await supabase
        .from("comment_reactions")
        .select("comment_id, reaction_type, user_id")
        .in("comment_id", allCommentIds);

      if (!reactionsError && reactions) {
        // Group reactions by comment
        const reactionsByComment: Record<string, any> = {};
        const userReactionsByComment: Record<string, string[]> = {};

        reactions.forEach((reaction: any) => {
          if (!reactionsByComment[reaction.comment_id]) {
            reactionsByComment[reaction.comment_id] = {};
            userReactionsByComment[reaction.comment_id] = [];
          }
          
          // Count reactions by type
          if (!reactionsByComment[reaction.comment_id][reaction.reaction_type]) {
            reactionsByComment[reaction.comment_id][reaction.reaction_type] = 0;
          }
          reactionsByComment[reaction.comment_id][reaction.reaction_type]++;

          // Track user's reactions
          if (reaction.user_id === userId) {
            userReactionsByComment[reaction.comment_id].push(reaction.reaction_type);
          }
        });

        // Add reaction data to comments
        const addReactionsToComments = (commentsArray: any[]) => {
          return commentsArray.map((comment: any) => ({
            ...comment,
            reaction_counts: reactionsByComment[comment.id] || {},
            user_reactions: userReactionsByComment[comment.id] || [],
            replies: comment.replies ? addReactionsToComments(comment.replies) : []
          }));
        };

        const commentsWithReactions = addReactionsToComments(comments);
        return res.json(commentsWithReactions);
      }
    }

    res.json(comments);
  } catch (error) {
    console.error("Error in GET comments:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get comment statistics
router.get("/:contentType/:contentId/stats", requireAuth, extractUserId, requireCommentsAccess, async (req: Request, res: Response) => {
  try {
    const { contentType, contentId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Validate content type
    if (!["script", "document", "slide"].includes(contentType)) {
      return res.status(400).json({ error: "Invalid content type" });
    }

    // Get project_id based on content type for subscription check
    let project_id;
    if (contentType === "script") {
      const { data: script, error: scriptError } = await supabase
        .from("scripts")
        .select("project_id")
        .eq("id", contentId)
        .single();

      if (scriptError || !script) {
        return res.status(404).json({ error: "Script not found" });
      }
      project_id = script.project_id;
    } else if (contentType === "slide") {
      // For slides, contentId is in format "documentId:slideId"
      const [documentId] = contentId.split(":");
      const { data: document, error: documentError } = await supabase
        .from("project_documents")
        .select("project_id")
        .eq("id", documentId)
        .single();

      if (documentError || !document) {
        return res.status(404).json({ error: "Document not found for slide" });
      }
      project_id = document.project_id;
    } else {
      const { data: document, error: documentError } = await supabase
        .from("project_documents")
        .select("project_id")
        .eq("id", contentId)
        .single();

      if (documentError || !document) {
        return res.status(404).json({ error: "Document not found" });
      }
      project_id = document.project_id;
    }

    // Use the database function to get stats
    const { data: stats, error } = await supabase.rpc("get_comment_stats", {
      p_content_type: contentType,
      p_content_id: contentId,
      p_user_id: userId
    });

    if (error) {
      console.error("Error fetching comment stats:", error);
      return res.status(500).json({ error: "Failed to fetch stats" });
    }

    // Return the first row of results (function returns a table)
    const result = stats?.[0] || {
      total_comments: 0,
      open_comments: 0,
      resolved_comments: 0,
      unread_count: 0
    };

    // Add project_id to the response so frontend can check subscription
    result.project_id = project_id;

    res.json(result);
  } catch (error) {
    console.error("Error in GET comment stats:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create a new comment
router.post("/", requireAuth, extractUserId, requireCommentsAccess, validateCommentInput, async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const {
      content_type,
      content_id,
      comment_text,
      comment_type = "general",
      visibility = "all",
      selection_data,
      parent_comment_id
    } = req.body;

    // Validate required fields
    if (!content_type || !content_id || !comment_text) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!["script", "document", "slide"].includes(content_type)) {
      return res.status(400).json({ error: "Invalid content type" });
    }

    // Get project_id based on content
    let project_id;
    if (content_type === "script") {
      const { data: script, error: scriptError } = await supabase
        .from("scripts")
        .select("project_id")
        .eq("id", content_id)
        .single();

      if (scriptError || !script) {
        return res.status(404).json({ error: "Script not found" });
      }
      project_id = script.project_id;
    } else if (content_type === "document") {
      const { data: document, error: documentError } = await supabase
        .from("project_documents")
        .select("project_id")
        .eq("id", content_id)
        .single();

      if (documentError || !document) {
        return res.status(404).json({ error: "Document not found" });
      }
      project_id = document.project_id;
    } else if (content_type === "slide") {
      // For slides, content_id format is "documentId:slideId"
      const [documentId] = content_id.split(":");
      if (!documentId) {
        return res.status(400).json({ error: "Invalid slide content_id format" });
      }
      const { data: document, error: documentError } = await supabase
        .from("project_documents")
        .select("project_id")
        .eq("id", documentId)
        .single();

      if (documentError || !document) {
        return res.status(404).json({ error: "Document not found for slide" });
      }
      project_id = document.project_id;
    }

    // Create comment
    const { data: comment, error } = await supabase
      .from("comments")
      .insert({
        content_type,
        content_id,
        project_id,
        user_id: userId,
        parent_comment_id,
        comment_text,
        comment_type,
        visibility,
        selection_data
      })
      .select(`
        *,
        user:users!user_id (
          id,
          full_name,
          email,
          avatar_url
        )
      `)
      .single();

    if (error) {
      console.error("Error creating comment:", error);
      return res.status(500).json({ error: "Failed to create comment" });
    }

    res.status(201).json(comment);
  } catch (error) {
    console.error("Error in POST comment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update a comment
router.put("/:commentId", requireAuth, extractUserId, requireCommentsAccess, async (req: Request, res: Response) => {
  try {
    const { commentId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { comment_text, status } = req.body;
    const updates: any = {};

    if (comment_text !== undefined) {
      updates.comment_text = comment_text;
    }

    if (status !== undefined) {
      if (!["open", "resolved", "dismissed"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      updates.status = status;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // Fetch comment to check ownership and permissions
    const { data: existingComment, error: fetchError } = await supabase
      .from("comments")
      .select("id, user_id, project_id")
      .eq("id", commentId)
      .eq("is_deleted", false)
      .single();

    if (fetchError || !existingComment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    const isCommentAuthor = existingComment.user_id === userId;

    // For text changes, only the comment author can edit
    if (comment_text !== undefined && !isCommentAuthor) {
      return res.status(403).json({ error: "Only the comment author can edit comment text" });
    }

    // For status changes, check if user is author OR has project write access
    if (status !== undefined && !isCommentAuthor) {
      // Check project access
      const { data: project } = await supabase
        .from("projects")
        .select("user_id")
        .eq("id", existingComment.project_id)
        .single();

      const isProjectOwner = project?.user_id === userId;
      let canChangeStatus = isProjectOwner;

      if (!isProjectOwner) {
        const { data: collaborator } = await supabase
          .from("project_collaborators")
          .select("role, status")
          .eq("project_id", existingComment.project_id)
          .eq("user_id", userId)
          .single();

        // Editor and admin can change comment status
        if (collaborator && collaborator.status === "active") {
          canChangeStatus = collaborator.role === "editor" || collaborator.role === "admin";
        }
      }

      if (!canChangeStatus) {
        return res.status(403).json({ error: "Not authorized to change comment status" });
      }

      // Track who resolved/dismissed the comment
      if (status === "resolved" || status === "dismissed") {
        updates.resolved_by = userId;
        updates.resolved_at = new Date().toISOString();
      } else if (status === "open") {
        updates.resolved_by = null;
        updates.resolved_at = null;
      }
    }

    // Update comment
    const { data: comment, error } = await supabase
      .from("comments")
      .update(updates)
      .eq("id", commentId)
      .select(`
        *,
        user:users!user_id (
          id,
          full_name,
          email,
          avatar_url
        ),
        resolved_by_user:users!resolved_by (
          id,
          full_name
        )
      `)
      .single();

    if (error) {
      console.error("Error updating comment:", error);
      return res.status(500).json({ error: "Failed to update comment" });
    }

    if (!comment) {
      return res.status(404).json({ error: "Comment not found or not authorized" });
    }

    res.json(comment);
  } catch (error) {
    console.error("Error in PUT comment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete a comment
router.delete("/:commentId", requireAuth, extractUserId, requireCommentsAccess, async (req: Request, res: Response) => {
  try {
    const { commentId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // First, check if the comment exists and if user has permission to delete it
    const { data: existingComment, error: fetchError } = await supabase
      .from("comments")
      .select("id, user_id, project_id")
      .eq("id", commentId)
      .eq("is_deleted", false)
      .single();

    if (fetchError) {
      console.error("Error fetching comment for deletion:", fetchError);
      return res.status(500).json({ error: "Failed to fetch comment" });
    }

    if (!existingComment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    // Check if user is the project owner
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("user_id")
      .eq("id", existingComment.project_id)
      .single();

    if (projectError) {
      console.error("Error fetching project for permission check:", projectError);
      return res.status(500).json({ error: "Failed to verify permissions" });
    }

    // Check permissions: user is comment author OR user is project owner
    const isCommentAuthor = existingComment.user_id === userId;
    const isProjectOwner = project?.user_id === userId;

    if (!isCommentAuthor && !isProjectOwner) {
      return res.status(403).json({ error: "Not authorized to delete this comment" });
    }

    // Soft delete by setting is_deleted flag
    const { data: comment, error } = await supabase
      .from("comments")
      .update({ is_deleted: true })
      .eq("id", commentId)
      .select("id")
      .single();

    if (error) {
      console.error("Error deleting comment:", error);
      return res.status(500).json({ error: "Failed to delete comment" });
    }

    if (!comment) {
      return res.status(404).json({ error: "Comment not found after delete attempt" });
    }

    res.json({ message: "Comment deleted successfully" });
  } catch (error) {
    console.error("Error in DELETE comment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add or remove reaction to a comment
router.post("/:commentId/reactions", requireAuth, extractUserId, requireCommentsAccess, async (req: Request, res: Response) => {
  try {
    const { commentId } = req.params;
    const { reaction_type } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!reaction_type) {
      return res.status(400).json({ error: "Reaction type is required" });
    }

    // Check if user already has this reaction
    const { data: existingReaction, error: checkError } = await supabase
      .from("comment_reactions")
      .select("id")
      .eq("comment_id", commentId)
      .eq("user_id", userId)
      .eq("reaction_type", reaction_type)
      .single();

    if (checkError && checkError.code !== "PGRST116") {
      console.error("Error checking existing reaction:", checkError);
      return res.status(500).json({ error: "Database error" });
    }

    if (existingReaction) {
      // Remove existing reaction
      const { error: deleteError } = await supabase
        .from("comment_reactions")
        .delete()
        .eq("id", existingReaction.id);

      if (deleteError) {
        console.error("Error removing reaction:", deleteError);
        return res.status(500).json({ error: "Failed to remove reaction" });
      }

      res.json({ message: "Reaction removed" });
    } else {
      // Add new reaction
      const { data: newReaction, error: insertError } = await supabase
        .from("comment_reactions")
        .insert({
          comment_id: commentId,
          user_id: userId,
          reaction_type
        })
        .select("id")
        .single();

      if (insertError) {
        console.error("Error adding reaction:", insertError);
        return res.status(500).json({ error: "Failed to add reaction" });
      }

      res.status(201).json({ message: "Reaction added", id: newReaction.id });
    }
  } catch (error) {
    console.error("Error in POST reaction:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Mark comment as read
router.post("/:commentId/read", requireAuth, extractUserId, requireCommentsAccess, async (req: Request, res: Response) => {
  try {
    const { commentId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Check if already exists
    const { data: existing, error: checkError } = await supabase
      .from("comment_read_status")
      .select("id")
      .eq("comment_id", commentId)
      .eq("user_id", userId)
      .single();

    if (checkError && checkError.code !== "PGRST116") {
      console.error("Error checking existing read status:", checkError);
      return res.status(500).json({ error: "Database error" });
    }

    if (existing) {
      // Already marked as read, update timestamp
      const { error: updateError } = await supabase
        .from("comment_read_status")
        .update({ read_at: new Date().toISOString() })
        .eq("id", existing.id);

      if (updateError) {
        console.error("Error updating read status:", updateError);
        return res.status(500).json({ error: "Failed to update read status" });
      }
    } else {
      // Insert new read status
      const { error: insertError } = await supabase
        .from("comment_read_status")
        .insert({
          comment_id: commentId,
          user_id: userId,
          read_at: new Date().toISOString()
        });

      if (insertError) {
        console.error("Error inserting read status:", insertError);
        return res.status(500).json({ error: "Failed to mark as read" });
      }
    }

    res.json({ message: "Comment marked as read" });
  } catch (error) {
    console.error("Error in POST read:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;