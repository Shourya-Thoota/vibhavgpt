import { Router } from "express";
import { createImageLibrary, imageAttachmentView } from "./image-library.js";

// Mounted after generationRouter's requireSession middleware.
export function createImageLibraryRouter(db) {
  const router = Router();
  const library = createImageLibrary(db);
  router.get("/image-folders", async (req, res, next) => {
    try { res.json({ folders: await library.listFolders(req.authSession.user.id) }); }
    catch (error) { next(error); }
  });
  router.post("/image-folders", async (req, res, next) => {
    try { res.status(201).json({ folder: await library.createFolder(req.authSession.user.id, req.body?.name) }); }
    catch (error) { next(error); }
  });
  router.patch("/image-folders/:id", async (req, res, next) => {
    try { res.json({ folder: await library.renameFolder(req.authSession.user.id, req.params.id, req.body?.name) }); }
    catch (error) { next(error); }
  });
  router.patch("/images/:id", async (req, res, next) => {
    try { res.json({ image: imageAttachmentView(await library.updateImage(req.authSession.user.id, req.params.id, req.body)) }); }
    catch (error) { next(error); }
  });
  router.get("/images", async (req, res, next) => {
    try {
      const { images, nextCursor } = await library.listImages(req.authSession.user.id, { folder: req.query.folder, cursor: req.query.cursor });
      res.json({ images: images.map(imageAttachmentView), nextCursor });
    } catch (error) { next(error); }
  });
  return router;
}
