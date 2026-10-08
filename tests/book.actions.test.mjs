import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/actions/book.actions.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
});

function loadActions({ userId = 'owner', book = { clerkId: 'owner' }, textResults = [], textFails = false } = {}) {
    const calls = { connections: 0, reads: 0, inserts: [], updates: [], searches: [] };
    const fallbackResults = [{ content: 'matching segment' }];
    const modules = {
        '@clerk/nextjs/server': { auth: async () => ({ userId }) },
        '@/database/mongoose': { connectToDatabase: async () => { calls.connections++; } },
        '@/lib/utils': {
            serializeData: (data) => JSON.parse(JSON.stringify(data)),
            escapeRegex: (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        },
        '@/database/models/book.model': {
            findById: () => { calls.reads++; return { lean: async () => book }; },
            findByIdAndUpdate: async (...args) => { calls.updates.push(args); },
        },
        '@/database/models/book-segment.model': {
            insertMany: async (segments) => { calls.inserts.push(segments); },
            find: (filter) => {
                calls.searches.push(filter);
                const chain = {
                    select: () => chain,
                    sort: () => chain,
                    limit: () => chain,
                    lean: async () => {
                        if (filter.$text && textFails) throw new Error('No text index');
                        return filter.$text ? textResults : fallbackResults;
                    },
                };
                return chain;
            },
        },
        mongoose: { Types: { ObjectId: class { constructor(value) { this.value = value; } } } },
        '@/lib/subscription.server': {},
    };
    const exports = {};
    vm.runInNewContext(outputText, {
        exports,
        require: (name) => {
            assert.ok(name in modules, `Unexpected import: ${name}`);
            return modules[name];
        },
        console: { log() {}, error() {} },
    });
    return { actions: exports, calls };
}

const segments = [{ text: 'Book text', segmentIndex: 0, pageNumber: 1, wordCount: 2, clerkId: 'injected' }];

for (const [name, options, suppliedUser] of [
    ['anonymous caller', { userId: null }, 'owner'],
    ['spoofed caller identity', {}, 'someone-else'],
    ['another user’s book', { book: { clerkId: 'someone-else' } }, 'owner'],
    ['missing book', { book: null }, 'owner'],
]) {
    test(`saveBookSegments rejects ${name} without writing`, async () => {
        const { actions, calls } = loadActions(options);
        const result = await actions.saveBookSegments('book-id', suppliedUser, segments);
        assert.equal(result.success, false);
        assert.equal(result.error, 'Unauthorized');
        assert.equal(calls.inserts.length, 0);
        assert.equal(calls.updates.length, 0);
        if ((!options.userId && 'userId' in options) || suppliedUser !== 'owner') {
            assert.equal(calls.connections, 0);
        }
    });
}

test('saveBookSegments writes only the authenticated owner and updates the count', async () => {
    const { actions, calls } = loadActions();
    const result = await actions.saveBookSegments('book-id', 'owner', segments);
    assert.equal(result.success, true);
    assert.equal(result.data.segmentsCreated, 1);
    assert.equal(calls.reads, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.inserts)), [[{
        clerkId: 'owner', bookId: 'book-id', content: 'Book text', segmentIndex: 0, pageNumber: 1, wordCount: 2,
    }]]);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.updates)), [['book-id', { totalSegments: 1 }]]);
});

for (const textFails of [false, true]) {
    for (const query of ['', '   ', 'a an to']) {
        test(`empty fallback keywords skip regex search (${JSON.stringify(query)}, text failure: ${textFails})`, async () => {
            const { actions, calls } = loadActions({ textFails });
            const result = await actions.searchBookSegments('book-id', query);
            assert.equal(result.success, true);
            assert.equal(result.data.length, 0);
            assert.equal(calls.searches.length, 1);
        });
    }
}

test('fallback searches escaped usable keywords', async () => {
    const { actions, calls } = loadActions();
    const result = await actions.searchBookSegments('book-id', 'a foo.bar baz');
    assert.equal(result.success, true);
    assert.equal(result.data.length, 1);
    assert.equal(calls.searches.length, 2);
    assert.equal(calls.searches[1].content.$regex, 'foo\\.bar|baz');
});

test('text search results bypass the fallback even with short keywords', async () => {
    const { actions, calls } = loadActions({ textResults: [{ content: 'a match' }] });
    const result = await actions.searchBookSegments('book-id', 'an');
    assert.equal(result.data[0].content, 'a match');
    assert.equal(calls.searches.length, 1);
});
