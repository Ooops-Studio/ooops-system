# @ooopsstudio/jobs

Bounded task scheduling and durable background job execution for Node.js. The package supports development memory storage and explicit durable Redis or PostgreSQL backends for production.

## Install

```sh
pnpm add @ooopsstudio/core @ooopsstudio/jobs
```

## Usage

```ts
import {registerJobs} from '@ooopsstudio/jobs'

await registerJobs(container, {preset: 'development'})
const jobs = container.get(TOK.Jobs)
jobs.registerTask({name: 'send-email'}, async ({payload, signal}) => {
  // Keep external side effects idempotent; execution is at least once.
})
await jobs.start()
await jobs.enqueue('send-email', {messageId: 'message-1'}, {idempotencyKey: 'message-1'})
```

Production requires an explicit durable backend and never falls back to memory. Redis and PostgreSQL integrations use structural client interfaces, so client libraries remain application-owned. Schema migrations are explicit; normal production startup performs compatibility checks and never runs DDL.

See the package subpaths for presets, admin access, backends, and migration artifacts.

## License

MIT.
