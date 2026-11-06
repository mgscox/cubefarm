import express from 'express';
import { IMAGE_LIMIT, IMAGE_ROUTE, images, type ImageStore } from './attachments.ts';

/** Raw bitmap uploads avoid multipart dependencies and keep the normal JSON request limit small. */
export function imageRouter(store: ImageStore = images) {
  const router = express.Router();
  router.post('/', express.raw({ type: 'image/*', limit: IMAGE_LIMIT }), (req, res, next) => {
    try {
      const name = store.save(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      res.status(201).json({ path: `${IMAGE_ROUTE}/${name}` });
    } catch (err) { next(err); }
  });
  router.get('/:name', (req, res, next) => {
    try {
      const name = String(req.params.name);
      const data = store.read(name);
      res.set({ 'Content-Type': store.mime(name), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
      res.send(data);
    } catch (err) { next(err); }
  });
  return router;
}
