import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const checkProjectArchived = async (req: Request, res: Response, next: NextFunction) => {
  // Get project ID from params or body
  const projectId = req.params.projectId || req.params.project_id || req.body.project_id;
  
  if (!projectId) {
    return next(); // If no project ID, let the request continue (will likely fail elsewhere)
  }

  try {
    // Check if project is archived
    const { data: project, error } = await supabase
      .from("projects")
      .select("status")
      .eq("id", projectId)
      .single();

    if (error) {
      return res.status(500).json({ error: "Failed to check project status" });
    }

    if (project?.status === 'archived') {
      return res.status(403).json({ 
        error: "This project is archived and cannot be modified. Contact support to unarchive this project." 
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({ error: "Failed to check project status" });
  }
};

// Special middleware for locations and characters that need to lookup project_id from the record
export const checkProjectArchivedByRecordId = (tableName: string, paramName: string = 'id') => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const recordId = req.params[paramName];
    
    
    if (!recordId) {
      return next();
    }

    try {
      // First get the project_id from the record
      const { data: record, error: recordError } = await supabase
        .from(tableName)
        .select("project_id")
        .eq("id", recordId)
        .single();

      if (recordError) {
        return next(); // Let the main route handle the not found error
      }

      if (!record) {
        return next(); // Let the main route handle the not found error
      }


      // Then check if that project is archived
      const { data: project, error: projectError } = await supabase
        .from("projects")
        .select("status")
        .eq("id", record.project_id)
        .single();

      if (projectError) {
        return res.status(500).json({ error: "Failed to check project status" });
      }


      if (project?.status === 'archived') {
        return res.status(403).json({ 
          error: "This project is archived and cannot be modified. Contact support to unarchive this project." 
        });
      }

      next();
    } catch (error) {
      //console.error('Archive middleware error:', error);
      return res.status(500).json({ error: "Failed to check project status" });
    }
  };
};