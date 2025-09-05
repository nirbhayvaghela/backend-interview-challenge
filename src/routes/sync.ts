import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);
  taskService.setSyncService(syncService);

  // Trigger manual sync
  router.post('/sync', async (req: Request, res: Response) => {
    // TODO: Implement sync endpoint
    // 1. Check connectivity first
    // 2. Call syncService.sync()
    // 3. Return sync result
    try {
      const online = await syncService.checkConnectivity();
      if (!online) {
        return res.status(503).json({
          error: 'Server not reachable',
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
        });
      }

      const result = await syncService.sync();
      return res.json(result);
    } catch (err: any) {
      console.error('[Sync API] /sync error', err);
      return res.status(500).json({
        error: err.message || 'Internal sync error',
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      });
    }
  });

  // Check sync status
  router.get('/status', async (req: Request, res: Response) => {
    // TODO: Implement sync status endpoint
    // 1. Get pending sync count
    // 2. Get last sync timestamp
    // 3. Check connectivity
    // 4. Return status summary
    try {
      // pending sync count
      const row = await db.get(
        `SELECT COUNT(*) as count FROM sync_queue WHERE IFNULL(retry_count,0) < ?`,
        [Number(process.env.SYNC_MAX_RETRY ?? 3)]
      );
      const pending = row?.count ?? 0;

      // last sync timestamp (store in meta table or tasks)
      const meta = await db.get(
        `SELECT value FROM meta WHERE key = 'last_sync_timestamp'`
      );
      const lastSyncTimestamp = meta?.value ?? null;

      // connectivity
      const isOnline = await syncService.checkConnectivity();

      return res.json({
        pending_sync_count: pending,
        last_sync_timestamp: lastSyncTimestamp,
        is_online: isOnline,
        sync_queue_size: pending,
      });
    } catch (err: any) {
      console.error('[Sync API] /status error', err);
      return res.status(500).json({
        error: err.message || 'Failed to get sync status',
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
      });
    }
  });

  // Batch sync endpoint (for server-side)
  router.post('/batch', async (req: Request, res: Response) => {
    // TODO: Implement batch sync endpoint
    // This would be implemented on the server side
    // to handle batch sync requests from clients
    return res.status(501).json({
      error: 'Batch sync is server-side only',
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
    });
  });

  // Health check endpoint
  router.get('/health', async (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}