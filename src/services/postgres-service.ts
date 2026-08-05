import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { logger } from "../lib/logger";
import crypto from 'crypto';

import { MemorySaver } from '@langchain/langgraph';
import { BaseCheckpointSaver, Checkpoint, CheckpointTuple, CheckpointMetadata, ChannelVersions, PendingWrite, CheckpointListOptions } from '@langchain/langgraph-checkpoint';

let pool: Pool | null = null;
let resilientCheckpointer: ResilientCheckpointer | null = null;

export class ResilientCheckpointer extends BaseCheckpointSaver {
    private pgSaver: any;
    private memSaver: MemorySaver;

    constructor(pgSaver: any) {
        super();
        this.pgSaver = pgSaver;
        this.memSaver = new MemorySaver();
    }

    async setup(): Promise<void> {
        try {
            if (this.pgSaver && typeof this.pgSaver.setup === 'function') {
                await this.pgSaver.setup();
            }
        } catch (e: any) {
            logger.warn(`[Checkpointer] Postgres setup warning: ${e.message}. Using in-memory fallback.`);
        }
    }

    async getTuple(config: any): Promise<CheckpointTuple | undefined> {
        try {
            if (this.pgSaver && typeof this.pgSaver.getTuple === 'function') {
                const res = await this.pgSaver.getTuple(config);
                if (res) return res;
            }
        } catch (e: any) {
            logger.warn(`[Checkpointer] Postgres getTuple failed: ${e.message}. Falling back to MemorySaver.`);
        }
        return await this.memSaver.getTuple(config);
    }

    async *list(config: any, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
        try {
            if (this.pgSaver && typeof this.pgSaver.list === 'function') {
                const gen = this.pgSaver.list(config, options);
                for await (const item of gen) {
                    yield item;
                }
                return;
            }
        } catch (e: any) {
            logger.warn(`[Checkpointer] Postgres list failed: ${e.message}. Falling back to MemorySaver.`);
        }
        const memGen = this.memSaver.list(config, options);
        for await (const item of memGen) {
            yield item;
        }
    }

    async put(config: any, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions): Promise<any> {
        await this.memSaver.put(config, checkpoint, metadata);
        try {
            if (this.pgSaver && typeof this.pgSaver.put === 'function') {
                return await this.pgSaver.put(config, checkpoint, metadata, newVersions);
            }
        } catch (e: any) {
            logger.warn(`[Checkpointer] Postgres put failed (${e.message}). Proceeding safely via MemorySaver.`);
        }
        return config;
    }

    async putWrites(config: any, writes: PendingWrite[], taskId: string): Promise<void> {
        await this.memSaver.putWrites(config, writes, taskId);
        try {
            if (this.pgSaver && typeof this.pgSaver.putWrites === 'function') {
                await this.pgSaver.putWrites(config, writes, taskId);
            }
        } catch (e: any) {
            logger.warn(`[Checkpointer] Postgres putWrites failed (${e.message}). Proceeding safely via MemorySaver.`);
        }
    }

    async deleteThread(threadId: string): Promise<void> {
        try {
            if (this.pgSaver && typeof this.pgSaver.deleteThread === 'function') {
                await this.pgSaver.deleteThread(threadId);
            }
        } catch (e: any) {
            logger.warn(`[Checkpointer] Postgres deleteThread failed: ${e.message}.`);
        }
        if (typeof (this.memSaver as any).deleteThread === 'function') {
            await (this.memSaver as any).deleteThread(threadId);
        }
    }
}

export interface Project {
    id: string;
    userId: string;
    title: string;
    phase: 'discovery' | 'building' | 'editing' | 'error';
    feed: any[];
    requirements?: string;
    designTokens: any;
    themeId?: string;
    machineId?: string | null;
    createdAt: any;
    updatedAt: any;
    previewImageUrl?: string;
}

export function getPool(): Pool {
    if (!pool) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error("DATABASE_URL is not set");
        }
        pool = new Pool({ connectionString });
    }
    return pool;
}

export function getCheckpointer(): any {
    if (!resilientCheckpointer) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            logger.warn("[Checkpointer] DATABASE_URL is not set. Using MemorySaver fallback.");
            return new MemorySaver();
        }
        const pgSaver = PostgresSaver.fromConnString(connectionString);
        resilientCheckpointer = new ResilientCheckpointer(pgSaver);
    }
    return resilientCheckpointer;
}

export async function initPostgres(): Promise<void> {
    const p = getPool();
    const client = await p.connect();
    try {
        logger.info("[Postgres] Checking/creating projects table...");
        await client.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id VARCHAR(255) PRIMARY KEY,
                user_id VARCHAR(255) NOT NULL,
                title VARCHAR(255) NOT NULL,
                phase VARCHAR(50) NOT NULL,
                feed JSONB NOT NULL DEFAULT '[]'::jsonb,
                requirements TEXT,
                design_tokens JSONB NOT NULL DEFAULT '{}'::jsonb,
                theme_id VARCHAR(255),
                machine_id VARCHAR(255),
                preview_image_url VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        logger.info("[Postgres] Projects table verified.");
    } catch (error) {
        logger.error(`[Postgres] Table initialization failed: ${error}`);
        throw error;
    } finally {
        client.release();
    }
}

function mapRowToProject(row: any): Project {
    return {
        id: row.id,
        userId: row.user_id,
        title: row.title,
        phase: row.phase,
        feed: row.feed || [],
        requirements: row.requirements || undefined,
        designTokens: row.design_tokens || {},
        themeId: row.theme_id || undefined,
        machineId: row.machine_id || null,
        createdAt: { _seconds: Math.floor(new Date(row.created_at).getTime() / 1000) },
        updatedAt: { _seconds: Math.floor(new Date(row.updated_at).getTime() / 1000) },
        previewImageUrl: row.preview_image_url || undefined,
    };
}

export async function createProject(data: Partial<Project>): Promise<string> {
    const p = getPool();
    const id = data.id || crypto.randomUUID();
    const userId = data.userId || 'anonymous-user';
    const title = data.title || 'New Theme Project';
    const phase = data.phase || 'discovery';
    const feed = JSON.stringify(data.feed || []);
    const requirements = data.requirements || null;
    const designTokens = JSON.stringify(data.designTokens || {});
    const themeId = data.themeId || null;
    const machineId = data.machineId || null;
    const previewImageUrl = data.previewImageUrl || null;

    await p.query(
        `INSERT INTO projects (id, user_id, title, phase, feed, requirements, design_tokens, theme_id, machine_id, preview_image_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
        [id, userId, title, phase, feed, requirements, designTokens, themeId, machineId, previewImageUrl]
    );

    logger.info(`[Postgres] Project created: ${id}`);
    return id;
}

export async function updateProject(projectId: string, patch: Partial<Project>): Promise<void> {
    const p = getPool();
    const keys = Object.keys(patch) as Array<keyof Project>;
    if (keys.length === 0) return;

    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    // Build query dynamically
    keys.forEach((key) => {
        let dbColumn: string | null = null;
        let val: any = patch[key];

        switch (key) {
            case 'userId':
                dbColumn = 'user_id';
                break;
            case 'title':
                dbColumn = 'title';
                break;
            case 'phase':
                dbColumn = 'phase';
                break;
            case 'feed':
                dbColumn = 'feed';
                val = JSON.stringify(val);
                break;
            case 'requirements':
                dbColumn = 'requirements';
                break;
            case 'designTokens':
                dbColumn = 'design_tokens';
                val = JSON.stringify(val);
                break;
            case 'themeId':
                dbColumn = 'theme_id';
                break;
            case 'machineId':
                dbColumn = 'machine_id';
                break;
            case 'previewImageUrl':
                dbColumn = 'preview_image_url';
                break;
        }

        if (dbColumn) {
            setClauses.push(`${dbColumn} = $${paramIndex}`);
            values.push(val);
            paramIndex++;
        }
    });

    setClauses.push(`updated_at = NOW()`);

    const query = `UPDATE projects SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`;
    values.push(projectId);

    await p.query(query, values);
    logger.info(`[Postgres] Project updated: ${projectId}`);
}

export async function getProject(projectId: string): Promise<Project | null> {
    const p = getPool();
    const res = await p.query('SELECT * FROM projects WHERE id = $1', [projectId]);
    if (res.rows.length === 0) return null;
    return mapRowToProject(res.rows[0]);
}

export async function listProjects(userId: string): Promise<Project[]> {
    const p = getPool();
    const res = await p.query('SELECT * FROM projects WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return res.rows.map(mapRowToProject);
}

export async function deleteProject(projectId: string): Promise<void> {
    const p = getPool();
    await p.query('DELETE FROM projects WHERE id = $1', [projectId]);
    logger.info(`[Postgres] Project deleted: ${projectId}`);
}
