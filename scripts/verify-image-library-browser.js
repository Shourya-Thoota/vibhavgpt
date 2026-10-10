import express from "express";
import cors from "cors";
import { createImageLibraryFixture } from "../test/helpers/image-library-db.js";
import { createImageLibraryRouter } from "../src/generation/image-library-router.js";

const { client, db } = await createImageLibraryFixture();
const app = express();
app.use(cors({ origin: "http://127.0.0.1:5173" }));
app.use(express.json());
app.use((req, res, next) => { req.authSession = { user: { id: "library-owner" } }; next(); });
app.use("/api/generation", createImageLibraryRouter(db));
app.get("/api/uploads/:id/preview", (req, res) => res.type("image/svg+xml").send('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#476576"/></svg>'));
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
const server = app.listen(4174, "127.0.0.1", () => console.log("Isolated image-library API: http://127.0.0.1:4174 (in-memory Postgres; no production access)"));
async function close() { server.close(); await client.close(); }
process.on("SIGINT", () => { void close(); });
