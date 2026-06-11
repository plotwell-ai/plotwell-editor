import { EventEmitter } from 'events';

// Centralized event bus for AI task status changes.
// Backend services emit here when tasks complete/fail;
// the SSE endpoint subscribes and pushes to connected clients.

export type AITaskEventType =
  // Scene transforms (background async)
  | 'transform:completed'
  | 'transform:failed'
  // Scene generation
  | 'scene:completed'
  | 'scene:failed'
  // Character operations
  | 'character:extracted'
  | 'character:failed'
  | 'character-image:completed'
  | 'character-image:failed'
  // Location operations
  | 'location:extracted'
  | 'location:failed'
  | 'location-image:completed'
  | 'location-image:failed'
  // Storyboard operations
  | 'storyboard:completed'
  | 'storyboard:failed'
  | 'storyboard-image:completed'
  | 'storyboard-image:failed'
  // Panel video (image-to-video) operations
  | 'panel-video:processing'
  | 'panel-video:completed'
  | 'panel-video:failed'
  // Document generation
  | 'document:completed'
  | 'document:failed'
  // Beat AI operations
  | 'beat:completed'
  | 'beat:failed'
  // Script Doctor
  | 'script-doctor:completed'
  | 'script-doctor:failed'
  // Agent writer
  | 'agent:step_complete'
  | 'agent:done'
  | 'agent:error';

export interface AITaskEvent {
  type: AITaskEventType;
  projectId: string;
  userId: string;
  payload: Record<string, any>;
}

class AITaskEventService extends EventEmitter {
  emit(event: 'task', data: AITaskEvent): boolean;
  emit(event: string, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  on(event: 'task', listener: (data: AITaskEvent) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  off(event: 'task', listener: (data: AITaskEvent) => void): this;
  off(event: string, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}

// Singleton — shared across the entire backend process
export const aiTaskEvents = new AITaskEventService();
aiTaskEvents.setMaxListeners(100);
