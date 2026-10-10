import { Router } from "express";
import { requireSession } from "../middleware/require-session.js";
import { searchWeb } from "./service.js";
export const searchRouter = Router();
searchRouter.post("/", requireSession, async (req, res, next) => { try { return res.json(await searchWeb(req.body?.query)); } catch (error) { return error.message === "A search query is required." ? res.status(400).json({ error: error.message }) : next(error); } });
