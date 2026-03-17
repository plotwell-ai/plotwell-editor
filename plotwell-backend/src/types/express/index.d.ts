import "express";
import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by requireAuth middleware */
    user?: {
      id: string;
      sub?: string;
      email?: string;
      [key: string]: unknown;
    };
    /** Set by extractUserId middleware */
    userId?: string;
    /** Set by addPricingService middleware */
    pricingService?: import("../../services/pricingService").PricingService;
    /** Set by extractProjectId or checkProjectAccess middleware */
    projectId?: string;
    /** Set by checkProjectAccess / checkProjectAccessByRecordId */
    collaboratorRole?: string;
    /** Set by AI credits middleware */
    aiCreditsRequired?: number;
    originalUserId?: string;
    targetUserId?: string;
    /** Set by script/document access middleware */
    scriptProjectId?: string;
    project_id?: string;
  }
}
