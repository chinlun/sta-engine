import { initFirestore, createProject, getProject, listProjects, deleteProject } from './src/services/firestore-service';
import dotenv from 'dotenv';

dotenv.config();

async function test() {
    console.log("🧪 Testing Firestore Service...");
    
    // Check if env vars are present
    if (!process.env.FIREBASE_PROJECT_ID) {
        console.warn("⚠️ Missing FIREBASE_PROJECT_ID. Skipping real Firestore test.");
        return;
    }

    try {
        const id = await createProject({
            userId: 'test-user',
            title: 'Test Project',
            phase: 'discovery',
            feed: [{ role: 'user', content: 'hello' }]
        });
        console.log("✅ Created project:", id);

        const project = await getProject(id);
        if (project && project.title === 'Test Project') {
            console.log("✅ Retrieved project correctly.");
        } else {
            console.error("❌ Failed to retrieve project or title mismatch.");
        }

        const list = await listProjects('test-user');
        if (list.length > 0) {
            console.log("✅ Listed projects correctly.");
        }

        await deleteProject(id);
        console.log("✅ Deleted project correctly.");

    } catch (err) {
        console.error("❌ Test failed:", err);
    }
}

test();
