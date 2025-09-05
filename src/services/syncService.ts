import axios from 'axios';

import { v4 as uuidv4 } from 'uuid';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

const MAX_RETRY = Number(process.env.SYNC_MAX_RETRY ?? 3);
const SYNC_BATCH_SIZE = Number(process.env.SYNC_BATCH_SIZE ?? 50);
export class SyncService {
  private apiUrl: string;

  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }

  async sync(): Promise<SyncResult> {
    // TODO: Main sync orchestration method
    // 1. Get all items from sync queue
    // 2. Group items by batch (use SYNC_BATCH_SIZE from env)
    // 3. Process each batch
    // 4. Handle success/failure for each item
    // 5. Update sync status in database
    // 6. Return sync result summary
    const result: SyncResult = {
      success: true,
      synced_items: 0,
      failed_items: 0,
      errors: [],
    };

    // If offline, short-circuit
    const online = await this.checkConnectivity();
    if (!online) {
      result.success = false;
      return result;
    }

    // Pull all queue items that still can be retried
    const items = await this.getQueueItemsToProcess();
    if (items.length === 0) return result;

    const batches = this.chunk(items, SYNC_BATCH_SIZE);

    for (const batch of batches) {
      try {
        const resp = await this.processBatch(batch);

        // index for quick lookup
        const byClientId = new Map<string, SyncQueueItem>();
        for (const it of batch) byClientId.set(it.id, it);

        for (const processed of resp.processed_items ?? []) {
          // server schema uses "client_id" for our queue item id
          const queueItem = byClientId.get(processed.client_id);
          if (!queueItem) continue;

          if (processed.status === 'success') {
            // Update task with server data & mark synced
            await this.updateSyncStatus(queueItem.task_id, 'synced', {
              ...processed.resolved_data,
              server_id: processed.server_id,
            });
            // remove processed item from queue
            await this.removeQueueItem(queueItem.id);
            result.synced_items += 1;
          } else if (processed.status === 'conflict') {
            // try to resolve conflict using LWW
            const local = await this.taskService.getTask(queueItem.task_id);
            const serverTask = processed.resolved_data as Task | undefined;

            if (!local || !serverTask) {
              // If we can’t resolve meaningfully, treat as error
              await this.handleSyncError(queueItem, new Error('Conflict but missing data'));
              result.failed_items += 1;
              result.errors.push({
                task_id: queueItem.task_id,
                operation: queueItem.operation,
                error: 'Conflict: missing data to resolve',
                timestamp: new Date(),
              });
              continue;
            }

            const winner = await this.resolveConflict(local, serverTask);

            if (winner === local) {
              // Local wins => requeue an update with local snapshot
              await this.handleSyncError(queueItem, new Error('Conflict: local newer, requeueing update'));
              await this.addToSyncQueue(local.id, 'update', {
                title: local.title,
                description: local.description,
                completed: local.completed,
                updated_at: local.updated_at,
                is_deleted: local.is_deleted,
              });
              result.failed_items += 1;
              result.errors.push({
                task_id: queueItem.task_id,
                operation: 'update',
                error: 'Conflict resolved (local newer). Requeued update.',
                timestamp: new Date(),
              });
            } else {
              // Server wins => update local to server version, mark synced & remove queue item
              await this.taskService.updateLocalOnly(queueItem.task_id, {
                title: serverTask.title,
                description: serverTask.description,
                completed: serverTask.completed,
                updated_at: serverTask.updated_at,
                is_deleted: !!(serverTask as any).is_deleted,
                server_id: (serverTask as any).server_id,
              });
              await this.updateSyncStatus(queueItem.task_id, 'synced', {
                ...serverTask,
                server_id: (serverTask as any).server_id,
              });
              await this.removeQueueItem(queueItem.id);

              // log the conflict
              result.errors.push({
                task_id: queueItem.task_id,
                operation: queueItem.operation,
                error: 'Conflict resolved using last-write-wins (server newer)',
                timestamp: new Date(),
              });
              result.synced_items += 1;
            }
          } else {
            // error from server
            await this.handleSyncError(queueItem, new Error((processed as any).error || 'Server error'));
            result.failed_items += 1;
            result.errors.push({
              task_id: queueItem.task_id,
              operation: queueItem.operation,
              error: (processed as any).error || 'Server error',
              timestamp: new Date(),
            });
          }

          // Mark last_sync_timestamp for status reporting
          await this.db.run(
            `UPDATE meta SET value = ? WHERE key = 'last_sync_timestamp'`,
            [new Date().toISOString()]
          ).catch(() => void 0);
        }

        // handle any items the server didn’t echo back as failures
        const returnedIds = new Set((resp.processed_items ?? []).map(i => i.client_id));
        for (const it of batch) {
          if (!returnedIds.has(it.id)) {
            await this.handleSyncError(it, new Error('No server response for item'));
            result.failed_items += 1;
            result.errors.push({
              task_id: it.task_id,
              operation: it.operation,
              error: 'No server response for item',
              timestamp: new Date(),
            });
          }
        }
      } catch (err: any) {
        // Whole batch failed (e.g., network hiccup) – mark each item for retry
        for (const it of batch) {
          await this.handleSyncError(it, err instanceof Error ? err : new Error(String(err)));
          result.failed_items += 1;
          result.errors.push({
            task_id: it.task_id,
            operation: it.operation,
            error: err?.message || 'Batch failed',
            timestamp: new Date(),
          });
        }
        result.success = false;
      }
    }

    return result;
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    // TODO: Add operation to sync queue
    // 1. Create sync queue item
    // 2. Store serialized task data
    // 3. Insert into sync_queue table
    try {
      await this.db.run(
        'INSERT INTO sync_queue (id, task_id, operation, data) VALUES (?, ?, ?, ?)',
        [uuidv4(), taskId, operation, JSON.stringify({ data }),]
      );
    } catch (error) {
      throw new Error('Failed to create task', error as any);
    }
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    // TODO: Process a batch of sync items
    // 1. Prepare batch request
    // 2. Send to server
    // 3. Handle response
    // 4. Apply conflict resolution if needed
    try {
      const payload: BatchSyncRequest = {
        items: items.map((it) => ({
          id: it.id,                 // queue item id becomes client_id on server response
          task_id: it.task_id,
          operation: it.operation,
          data: this.safeParseData(it.data),
          created_at: it.created_at,
          retry_count: it.retry_count ?? 0,
        })),
        client_timestamp: new Date(),
      };
  
      const { data } = await axios.post<BatchSyncResponse>(`${this.apiUrl}/batch`, payload, {
        timeout: 15000,
      });
      return data;
    } catch (error) {
      throw new Error("Faield to process batch", error as any)
    }

  }

  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    // TODO: Implement last-write-wins conflict resolution
    // 1. Compare updated_at timestamps
    // 2. Return the more recent version
    // 3. Log conflict resolution decision
    const localUpdated = new Date(localTask.updated_at).getTime();
    const serverUpdated = new Date(serverTask.updated_at).getTime();

    const winner = localUpdated >= serverUpdated ? localTask : serverTask;
    const loser = winner === localTask ? serverTask : localTask;

    console.warn(
      `[Sync] Conflict resolved LWW. Winner=${winner.id} (${new Date(
        winner.updated_at
      ).toISOString()}), Loser=${loser.id} (${new Date(loser.updated_at).toISOString()})`
    );

    return winner;
  }

  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    // TODO: Update task sync status
    // 1. Update sync_status field
    // 2. Update server_id if provided
    // 3. Update last_synced_at timestamp
    // 4. Remove from sync queue if successful
    const now = new Date().toISOString();

    // Merge server fields into the task when present
    const fields: string[] = [`sync_status = ?`, `last_synced_at = ?`];
    const params: any[] = [status, now];

    if (serverData?.server_id != null) {
      fields.push(`server_id = ?`);
      params.push(serverData.server_id);
    }
    if (serverData?.updated_at != null) {
      fields.push(`updated_at = ?`);
      params.push(serverData.updated_at);
    }
    if (serverData?.title != null) {
      fields.push(`title = ?`);
      params.push(serverData.title);
    }
    if (serverData?.description != null) {
      fields.push(`description = ?`);
      params.push(serverData.description);
    }
    if (typeof serverData?.completed === 'boolean') {
      fields.push(`completed = ?`);
      params.push(serverData.completed ? 1 : 0);
    }
    if (typeof (serverData as any)?.is_deleted === 'boolean') {
      fields.push(`is_deleted = ?`);
      params.push((serverData as any).is_deleted ? 1 : 0);
    }

    params.push(taskId);

    await this.db.run(
      `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`,
      params
    );
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    // TODO: Handle sync errors
    // 1. Increment retry count
    // 2. Store error message
    // 3. If retry count exceeds limit, mark as permanent failure
    const nextRetry = (item.retry_count ?? 0) + 1;

    // record error on queue item
    await this.db.run(
      `UPDATE sync_queue
         SET retry_count = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [nextRetry, error.message, new Date().toISOString(), item.id]
    );

    if (nextRetry >= MAX_RETRY) {
      // mark task as error
      await this.updateSyncStatus(item.task_id, 'error');
    }
  }

  async checkConnectivity(): Promise<boolean> {
    // TODO: Check if server is reachable
    // 1. Make a simple health check request
    // 2. Return true if successful, false otherwise
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  private async removeQueueItem(queueItemId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM sync_queue WHERE id = ?`,
      [queueItemId]
    );
  }

  private async getQueueItemsToProcess(): Promise<SyncQueueItem[]> {
    // Only items that haven’t exceeded retry limit, ordered by created_at
    return await this.db.all(
      `SELECT id, task_id, operation, data, created_at, retry_count
         FROM sync_queue
        WHERE IFNULL(retry_count, 0) < ?
        ORDER BY datetime(created_at) ASC`,
      [MAX_RETRY]
    );
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    if (size <= 0) return [arr];
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  private safeParseData(raw: any): Record<string, any> {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}