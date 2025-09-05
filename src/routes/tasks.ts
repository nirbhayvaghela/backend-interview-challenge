import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';

export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);
  taskService.setSyncService(syncService);

  // Get all tasks
  router.get('/', async (req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      return res.status(200).json(tasks);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      return res.status(200).json(task); // Added return here
    } catch (error) {
      return res.status(500).json({ error: 'Failed to fetch task' }); // Added return here
    }
  });

  // Create task
  router.post('/', async (req: Request, res: Response) => {
    // TODO: Implement task creation endpoint
    // 1. Validate request body
    // 2. Call taskService.createTask()
    // 3. Return created task
    try {
      // validate request body
      const { title, description } = req.body;
      if (!title || typeof title !== 'string') {
        return res.status(400).json({ error: 'Title is required and must be a string' });
      }
      if (!description || typeof description !== 'string') {
        return res.status(400).json({ error: 'Description is required and must be a string' });
      }

      // Call taskService.createTask()
      const task = await taskService.createTask({ title, description });

      return res.status(201).json(task);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Update task
  router.put('/:id', async (req: Request, res: Response) => {
    // TODO: Implement task update endpoint
    // 1. Validate request body
    // 2. Call taskService.updateTask()
    // 3. Handle not found case
    // 4. Return updated task
    try {
      // Validate request body
      const { title, description, completed } = req.body;
      if (!title && !description && completed !== undefined) {
        return res.status(400).json({ error: 'At least one field (title, description, completed) must be provided for update' });
      }
      if (title || typeof title !== 'string') {
        return res.status(400).json({ error: 'Title must be a string' });
      }
      if (description || typeof description !== 'string') {
        return res.status(400).json({ error: 'Description must be a string' });
      }
      if (completed !== undefined && typeof completed !== 'boolean') {
        return res.status(400).json({ error: 'Completed status must be boolean.' });
      }

      // Handle not found case
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
      }

      // Call taskService.updateTask()
      const updatedTask = await taskService.updateTask(req.params.id, { title, description, completed });

      return res.status(200).json(updatedTask);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Delete task
  router.delete('/:id', async (req: Request, res: Response) => {
    // TODO: Implement task deletion endpoint
    // 1. Call taskService.deleteTask()
    // 2. Handle not found case
    // 3. Return success response
    try {
      // Handle not found case
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }

      // Call taskService.deleteTask()
      await taskService.deleteTask(req.params.id);

      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  return router;
}