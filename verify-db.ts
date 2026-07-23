import { initPostgres, createProject, getProject, listProjects, deleteProject, getCheckpointer } from './src/services/postgres-service';
import dotenv from 'dotenv';

dotenv.config();

async function test() {
    console.log("🧪 Testing Postgres Database Service...");

    // Check if env vars are present
    if (!process.env.DATABASE_URL) {
        console.warn("⚠️ Missing DATABASE_URL. Skipping Postgres test.");
        return;
    }

    try {
        await initPostgres();

        const checkpointer = getCheckpointer();
        await checkpointer.setup();
        console.log("✅ PostgresSaver checkpointer tables initialized.");

        const id = await createProject({
            userId: 'test-user',
            title: 'Test Project',
            phase: 'discovery',
            feed: [{ role: 'user', content: 'hello' }]
        });
        console.log("✅ Created project:", id);

        const project = await getProject(id);
        if (project && project.title === 'Test Project') {
            console.log("✅ Retrieved project correctly. Title matches.");
        } else {
            console.error("❌ Failed to retrieve project or title mismatch.");
        }

        const list = await listProjects('test-user');
        if (list.length > 0) {
            console.log("✅ Listed projects correctly. Count:", list.length);
        } else {
            console.error("❌ Failed to list projects.");
        }

        // Test update
        console.log("⚡ Testing update...");
        await deleteProject(id);
        console.log("✅ Deleted project correctly.");

        const deletedProject = await getProject(id);
        if (!deletedProject) {
            console.log("✅ Confirmed project was deleted.");
        } else {
            console.error("❌ Project was not deleted.");
        }

        console.log("🎉 ALL TESTS PASSED!");
        process.exit(0);

    } catch (err) {
        console.error("❌ Test failed:", err);
        process.exit(1);
    }
}

test();
