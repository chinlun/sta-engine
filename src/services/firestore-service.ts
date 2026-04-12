import * as admin from 'firebase-admin';
import { logger } from "../lib/logger";

let firestore: admin.firestore.Firestore | null = null;

/**
 * Deep cleans an object to ensure it is compatible with Firestore.
 * Removes non-serializable properties and ensures it's a plain JS object.
 */
function cleanForFirestore(data: any): any {
    if (!data) return data;
    try {
        return JSON.parse(JSON.stringify(data));
    } catch (e) {
        logger.warn(`[Firestore] Deep clean failed for object, attempting shallow copy: ${e}`);
        return { ...data };
    }
}

/**
 * Global Project Interface for Firestore records.
 */
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
    createdAt: admin.firestore.Timestamp;
    updatedAt: admin.firestore.Timestamp;
    previewImageUrl?: string;
}

/**
 * Initializes Firestore using the Service Account defined in environment variables.
 * Supports GOOGLE_APPLICATION_CREDENTIALS path or inline key.
 */
export function initFirestore(): admin.firestore.Firestore {
    if (firestore) return firestore;

    try {
        if (!admin.apps.length) {
            const privateKey = process.env.FIREBASE_PRIVATE_KEY 
                ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
                : undefined;

            let projectId = process.env.FIREBASE_PROJECT_ID;
            
            // If we have a credentials path but no explicit project ID, 
            // try to read it from the file for absolute certainty.
            if (!projectId && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    const credPath = path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS);
                    const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
                    projectId = creds.project_id;
                } catch (e) {
                    logger.warn(`[Firestore] Failed to extract projectId from service account file: ${e}`);
                }
            }

            const config: admin.AppOptions = {
                credential: process.env.GOOGLE_APPLICATION_CREDENTIALS
                    ? admin.credential.cert(process.env.GOOGLE_APPLICATION_CREDENTIALS)
                    : (projectId && process.env.FIREBASE_CLIENT_EMAIL && privateKey)
                        ? admin.credential.cert({
                            projectId: projectId,
                            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                            privateKey: privateKey,
                        })
                        : admin.credential.applicationDefault(),
                projectId: projectId // Explicitly pass to avoid environment detection errors
            };

            admin.initializeApp(config);
            logger.info(`[Firestore] Firebase Admin initialized for project: ${projectId}`);
        }
        firestore = admin.firestore();
        return firestore;
    } catch (error) {
        logger.error(`[Firestore] Initialization failed: ${error}`);
        throw error;
    }
}


/**
 * Creates a new project document in Firestore.
 */
export async function createProject(data: Partial<Project>): Promise<string> {
    const db = initFirestore();
    const now = admin.firestore.Timestamp.now();
    
    const projectData = cleanForFirestore({
        ...data,
        createdAt: now,
        updatedAt: now,
    });

    const docRef = await db.collection('projects').add(projectData);
    logger.info(`[Firestore] Project created: ${docRef.id}`);
    return docRef.id;
}

/**
 * Updates an existing project with a partial patch.
 */
export async function updateProject(projectId: string, patch: Partial<Project>): Promise<void> {
    const db = initFirestore();
    const now = admin.firestore.Timestamp.now();

    const cleanPatch = cleanForFirestore({
        ...patch,
        updatedAt: now
    });

    await db.collection('projects').doc(projectId).update(cleanPatch);
    
    logger.info(`[Firestore] Project updated: ${projectId}`);
}

/**
 * Fetches a single project by ID.
 */
export async function getProject(projectId: string): Promise<Project | null> {
    const db = initFirestore();
    const doc = await db.collection('projects').doc(projectId).get();
    
    if (!doc.exists) return null;
    
    return { id: doc.id, ...doc.data() } as Project;
}

/**
 * Lists projects for a specific user, ordered by updatedAt desc.
 */
export async function listProjects(userId: string): Promise<Project[]> {
    const db = initFirestore();
    const snapshot = await db.collection('projects')
        .where('userId', '==', userId)
        .orderBy('updatedAt', 'desc')
        .get();
        
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Project));
}

/**
 * Deletes a project document.
 */
export async function deleteProject(projectId: string): Promise<void> {
    const db = initFirestore();
    await db.collection('projects').doc(projectId).delete();
    logger.info(`[Firestore] Project deleted: ${projectId}`);
}
