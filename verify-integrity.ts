import { IntegrityManager, ValidationError } from './src/services/integrity-manager';

async function runTests() {
    console.log("🚀 Running IntegrityManager Tests...\n");

    const tests = [
        {
            name: "Fail: Nested Liquid in {% stylesheet %}",
            modifications: [{
                filePath: "sections/test.liquid",
                action: "create",
                content: "{% stylesheet %}.test { color: {{ settings.color }}; }{% endstylesheet %}"
            }],
            shouldFail: true,
            expectedError: "Liquid tags are not allowed inside {% stylesheet %} blocks"
        },
        {
            name: "Fail: Invalid JSON in {% schema %}",
            modifications: [{
                filePath: "sections/test.liquid",
                action: "create",
                content: "{% schema %}{ \"name\": \"Test\", \"settings\": [] , }{% endschema %}"
            }],
            shouldFail: true,
            expectedError: "Invalid JSON in {% schema %} block"
        },
        {
            name: "Fail: Missing section file reference in templates/index.json",
            modifications: [
                {
                    filePath: "templates/index.json",
                    action: "update",
                    content: JSON.stringify({ sections: { "hero": { "type": "missing-hero" } } })
                }
            ],
            shouldFail: true,
            expectedError: "Missing section file: sections/missing-hero.liquid"
        },
        {
            name: "Pass: Valid configuration",
            modifications: [
                {
                    filePath: "sections/hero.liquid",
                    action: "create",
                    content: "<div>Content</div>{% schema %}{ \"name\": \"Hero\" }{% endschema %}"
                },
                {
                    filePath: "templates/index.json",
                    action: "update",
                    content: JSON.stringify({ sections: { "hero": { "type": "hero" } } })
                }
            ],
            shouldFail: false
        }
    ];

    for (const test of tests) {
        try {
            console.log(`Testing: ${test.name}`);
            IntegrityManager.validate(test.modifications as any);
            if (test.shouldFail) {
                console.error(`❌ FAILED: Expected error but passed.`);
            } else {
                console.log(`✅ PASSED\n`);
            }
        } catch (e: any) {
            if (test.shouldFail && e.message.includes(test.expectedError!)) {
                console.log(`✅ PASSED (Caught expected error: ${e.message})\n`);
            } else {
                console.error(`❌ FAILED: ${e.message}\n`);
            }
        }
    }
}

runTests();
