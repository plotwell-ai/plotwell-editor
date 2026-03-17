import { Router } from "express";
import * as charactersController from "../controllers/charactersController";
import { upload } from "../services/imageService";
import { checkProjectArchived, checkProjectArchivedByRecordId } from "../middleware/archiveMiddleware";
import { requireAuth, checkProjectAccess, checkProjectAccessByRecordId } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, checkProjectAccess, charactersController.getAll);
router.post("/", requireAuth, checkProjectAccess, checkProjectArchived, charactersController.create);
router.put("/:id", requireAuth, checkProjectAccessByRecordId("characters", true), checkProjectArchivedByRecordId("characters"), charactersController.update);
router.delete("/:id", requireAuth, checkProjectAccessByRecordId("characters", true), checkProjectArchivedByRecordId("characters"), charactersController.remove);

// Image routes
router.post("/:id/upload-image", requireAuth, checkProjectAccessByRecordId("characters", true), checkProjectArchivedByRecordId("characters"), upload.single('image'), charactersController.uploadImage);

export default router;