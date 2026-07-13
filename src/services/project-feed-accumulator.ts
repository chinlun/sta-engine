import { updateProject, Project } from "./postgres-service";
import { logger } from "../lib/logger";

/**
 * In-memory store for active project feeds.
 * This allows us to accumulate feed items (thinking, progress, messages)
 * and flush them to Postgres at specific milestones to optimize writes.
 */
class ProjectFeedAccumulator {
    private feeds: Map<string, any[]> = new Map();

    /**
     * Initializes or merges an accumulator for a project.
     * Ensures we don't drop existing history if .create is called multiple times.
     */
    create(projectId: string, incomingFeed: any[] = []) {
        const existingFeed = this.feeds.get(projectId) || [];
        
        // Merge strategy: Keep existing items, append incoming ones if they aren't already there.
        // For simple messages, we check content uniquely. For events, we keep them all.
        const mergedFeed = [...existingFeed];
        for (const item of incomingFeed) {
            const isDuplicate = existingFeed.some(existing => 
                existing.role === item.role && existing.content === item.content && item.role !== undefined
            );
            if (!isDuplicate) {
                mergedFeed.push(JSON.parse(JSON.stringify(item)));
            }
        }

        this.feeds.set(projectId, mergedFeed);
        logger.debug(`[Accumulator] Initialized/Merged feed for project: ${projectId} (Total items: ${mergedFeed.length})`);
    }

    /**
     * Appends a new item to the in-memory feed.
     * Consolidates "thinking" deltas into single blocks for historical cleanliness.
     */
    append(projectId: string, item: any) {
        let feed = this.feeds.get(projectId);
        if (!feed) {
            feed = [];
            this.feeds.set(projectId, feed);
        }
        
        try {
            // Drop non-serializable entries
            const cleanItem = JSON.parse(JSON.stringify(item));

            // LOGIC: Consolidate "thinking" events to avoid massive feed bloat in Postgres
            if (cleanItem.type === 'thinking' && cleanItem.component) {
                // Search backwards for the most recent thinking block for this specific node/component
                for (let i = feed.length - 1; i >= 0; i--) {
                    const existing = feed[i];
                    
                    if (existing.type === 'thinking') {
                        // STRICT MATCH: Node and Component must match exactly.
                        if (existing.node === cleanItem.node && existing.component === cleanItem.component) {
                            existing.text = (existing.text || "") + (cleanItem.text || "");
                            logger.debug(`[Accumulator] Match: Found ${existing.node}/${existing.component} block. Appending delta.`);
                            return; // Success
                        } else {
                            // This Log is for debugging "bleeding" - if we see many mismatches here it's fine, 
                            // it just means we are skipping non-matching blocks.
                            // logger.debug(`[Accumulator] Skip: ${existing.node}/${existing.component} != ${cleanItem.node}/${cleanItem.component}`);
                        }
                    }
                    
                    // Kill search if we go too deep (100 items is plenty for active components)
                    if (feed.length - i > 150) break;
                }
                
                // If we get here, no match was found.
                logger.info(`[Accumulator] Starting NEW thinking block for component: "${cleanItem.component}" (Node: ${cleanItem.node})`);
            }

            feed.push(cleanItem);
        } catch (e) {
            logger.warn(`[Accumulator] Failed to clean item for project ${projectId}: ${e}`);
            feed.push({ ...item, _cleaning_error: true });
        }
    }

    /**
     * Flushes the current in-memory feed to Postgres.
     */
    async flush(projectId: string) {
        const feed = this.feeds.get(projectId);
        if (!feed) {
            logger.warn(`[Accumulator] Attempted to flush non-existent feed for project: ${projectId}`);
            return;
        }

        try {
            await updateProject(projectId, { feed });
            logger.debug(`[Accumulator] Flushed ${feed.length} items to Postgres for project: ${projectId}`);
        } catch (error) {
            logger.error(`[Accumulator] Failed to flush project ${projectId}: ${error}`);
        }
    }

    /**
     * Retrieves the current in-memory feed.
     * Used for SSE reconnection (GET /api/projects/:id/live).
     */
    get(projectId: string): any[] {
        return this.feeds.get(projectId) || [];
    }

    /**
     * Removes the feed from memory once the build/modify is complete and successfully flushed.
     */
    destroy(projectId: string) {
        this.feeds.delete(projectId);
        logger.debug(`[Accumulator] Destroyed feed storage for project: ${projectId}`);
    }
}

export const projectFeedAccumulator = new ProjectFeedAccumulator();
