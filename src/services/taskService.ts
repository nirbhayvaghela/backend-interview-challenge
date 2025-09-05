import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';
import { SyncService } from './syncService';

export class TaskService {
  syncService: SyncService | undefined;

  constructor(private db: Database) { }

  setSyncService(syncService: SyncService) {
    this.syncService = syncService;
  }

  async createTask(taskData: Partial<Task>): Promise<Task> {
    // TODO: Implement task creation
    // 1. Generate UUID for the task
    // 2. Set default values (completed: false, is_deleted: false)
    // 3. Set sync_status to 'pending'
    // 4. Insert into database
    // 5. Add to sync queue
    const params = [
      uuidv4(),
      taskData.title,
      taskData.description || '',
    ];

    try {
      await this.db.run(
        `INSERT INTO tasks (id, title, description) VALUES (?, ?, ?)`,
        params
      );

      const createdTask = await this.db.get('SELECT * FROM tasks WHERE id = ?', [params[0]]);

      if (!createdTask) {
        throw new Error('Failed to create task');
      }

      if (this.syncService) {
        await this.syncService.addToSyncQueue(params[0]!, 'create', createdTask);
      }

      return createdTask;
    } catch (error) {
      throw new Error('Failed to create task', error as any);
    }
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    // TODO: Implement task update
    // 1. Check if task exists
    // 2. Update task in database
    // 3. Update updated_at timestamp
    // 4. Set sync_status to 'pending'
    // 5. Add to sync queue

    try {
      const setClauses: string[] = [];
      const params: any[] = [];

      if (updates.title !== undefined) {
        setClauses.push('title = ?');
        params.push(updates.title);
      }

      if (updates.description !== undefined) {
        setClauses.push('description = ?');
        params.push(updates.description);
      }

      if (updates.completed !== undefined) {
        setClauses.push('completed = ?');
        params.push(updates.completed ? 1 : 0);
      }

      setClauses.push('updated_at = CURRENT_TIMESTAMP');
      setClauses.push("sync_status = 'pending'");

      const sql = `
       UPDATE tasks
       SET ${setClauses.join(', ')}
       WHERE id = ? AND is_deleted = 0
      `;

      params.push(id);

      await this.db.run(sql, params);

      const updatedTask = await this.getTask(id);

      if (this.syncService) {
        await this.syncService.addToSyncQueue(id, 'update', updatedTask!);
      }

      return updatedTask;
    } catch (error) {
      throw new Error('Failed to update task', error as any);
    }
  }

  async deleteTask(id: string): Promise<boolean> {
    // TODO: Implement soft delete
    // 1. Check if task exists
    // 2. Set is_deleted to true
    // 3. Update updated_at timestamp
    // 4. Set sync_status to 'pending'
    // 5. Add to sync queue
    try {
      await this.db.run(
        `UPDATE tasks SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP, sync_status = 'pending' WHERE id = ?`,
        [id]
      );

      const deletedTask = await this.getTask(id);

      if (this.syncService) {
        await this.syncService.addToSyncQueue(id, 'delete', deletedTask!);
      }

      if (deletedTask?.is_deleted)
        return true;
      else
        return false;
    } catch (error) {
      throw new Error('Failed to delete task', error as any);
    }
  }

  async getTask(id: string): Promise<Task | null> {
    // TODO: Implement get single task
    // 1. Query database for task by id
    // 2. Return null if not found or is_deleted is true
    try {
      const task = await this.db.get('SELECT * FROM tasks WHERE id = ? AND is_deleted = 0', [id]);
      return task || null;
    } catch (error) {
      throw new Error('Failed to create task', error as any);
    }
  }

  async getAllTasks(): Promise<Task[]> {
    // TODO: Implement get all non-deleted tasks
    // 1. Query database for all tasks where is_deleted = false
    // 2. Return array of tasks
    try {
      const tasks = await this.db.all('SELECT * FROM tasks WHERE is_deleted = 0', []);
      return tasks;
    } catch (error) {
      console.error('Error fetching tasks:', error);
    }
    return [];
    // throw new Error('Not implemented');
  }

  async getTasksNeedingSync(): Promise<Task[]> {
    // TODO: Get all tasks with sync_status = 'pending' or 'error'
    throw new Error('Not implemented');
  }
}