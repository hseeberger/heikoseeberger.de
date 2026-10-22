+++
title = "Why you should use a bounded mailbox"
date = 2026-10-22
path = "2026-10-22-bounded-mailbox"

[taxonomies]
tags = ["rust","actors","tellus"]
+++

Every actor in [tellus](https://tellus.rs) owns a mailbox, and by default that mailbox is unbounded. Nevertheless the [documentation](https://tellus.rs/docs/how-to/apply-backpressure/) now recommends bounding every mailbox. Why recommend the opposite of the default? Because an unbounded mailbox postpones a problem instead of solving it, and in this post I want to show that with numbers. We will also look at how to choose a capacity, and why tellus still defaults to unbounded.

## Telling never waits

In tellus, `tell` tries to put a message into the mailbox and returns without waiting for space. That follows from the [synchronous message handlers](https://heikoseeberger.de/2026-10-18-why-sync-handlers/). When an actor calls `tell` from its synchronous `receive` handler, waiting for space in the recipient's mailbox would block the Tokio worker thread running that handler. It could also deadlock: if two actors have full mailboxes and each handler waits to send to the other, neither can finish its handler and dequeue the next message to free space.

So what happens when a producer tells messages faster than an actor handles them? Let's measure it. Here is the core of a little program which tells an actor a number of messages of 1 KiB each:

```rust
let config = ActorConfig::default().with_mailbox_capacity(capacity);
let system = ActorSystem::with_config(Slow, config);
for _ in 0..messages {
    system.root().tell(vec![0; 1024]);
}
```

`Slow` sleeps for a millisecond in `receive`. We would never do that in real code, but it makes the actor reliably slower than the loop. Before and after the loop, we read the resident memory of the process. The [full program is on GitHub](https://gist.github.com/hseeberger/4f979fd3b25081e3c7e26deb748ec7c5). I ran it as a release build on a Tokio runtime with 4 worker threads, logging at warn level to a file.

With an unbounded mailbox, the memory grows by 101 MiB for 100,000 messages and by 1,014 MiB for a million. Three runs each gave the same numbers within a MiB. Nothing fails, and we find nothing in the logs. The mailbox just keeps growing until the producer stops, or until the OOM killer of the operating system stops the whole process.

Notice that the slow actor is not a bug here. A traffic spike or many producers telling the same actor are enough to make a consumer fall behind its producers. The question is how we find out.

## What a bounded mailbox does

With a mailbox capacity of 1,000, the same program grows by 1 MiB, no matter whether it sends 100,000 or a million messages. The mailbox never holds more than 1,000 messages, and `tell` drops every message beyond that. tellus logs each drop at warn level as a dead letter:

```txt
WARN tellus::actor_ref: dead letter actor_id=01a15329-0159-74ee-9be5-b7a79fa8700d message_type="alloc::vec::Vec<u8>" error=mailbox full source=no capacity left
```

For a million messages, we get about 998,000 such lines. Well, that is a lot of logging. But it tells us exactly what the unbounded mailbox never told us: which actor cannot keep up, and with which kind of message.

A few more details matter. A full mailbox drops the newest message and keeps the older ones. An `ask` to a full mailbox fails right away with `AskError::MailboxFull`. And a terminated signal is always delivered, whatever the capacity, so death watch keeps working under overload.

But wait, is that backpressure? No. A bounded mailbox in tellus does not slow the producer down; it only caps what the consumer has to hold. `tell` cannot wait, so we express backpressure through the messaging protocol. Work pulling lets the consumer decide when it gets work, and that also gives us the best way to choose a capacity.

## Choosing the capacity

Ideally, the protocol tells us how many messages can be queued at most. Let's look at work pulling, the example of the [backpressure how-to](https://tellus.rs/docs/how-to/apply-backpressure/). A manager owns a queue of documents, and each worker requests the next document whenever it is ready. A worker never has more than one job in flight, so a capacity of one is enough for it. And the manager never holds more requests than there are workers:

```rust
let config = ActorConfig::default().with_mailbox_capacity(MailboxCapacity::Bounded(WORKERS));
let system = ActorSystem::with_config(Manager, config);
```

Here the capacity documents a property of the protocol, and tellus enforces it.

Where the protocol does not bound the messages in flight, we size the mailbox by the largest burst the actor should absorb. Then we decide what a dropped message costs. A dropped periodic reading costs little, because the next one follows soon anyway. A dropped request costs its answer. From outside an actor we send it with `ask`, which reports the full mailbox. Between actors, we bound the requests in flight by the protocol, as work pulling does.

Does a generous capacity cost memory? Only for the messages the mailbox actually holds. The capacity does not preallocate space for messages: the underlying channel is unbounded in any case, and a counter limits how many messages it accepts. But the capacity counts messages, not bytes: 1,000 messages of 1 KiB take about 1 MiB, 1,000 messages of 1 MiB about 1 GiB.

## Why unbounded is still the default

If bounded mailboxes are better, why does tellus not use one by default? Because no capacity fits every actor. A device which receives a reading per second may need only a handful of slots, a manager needs one per worker, and an actor absorbing bursts of requests may need thousands. Any default would be too small for some actors and arbitrary for the others. And a default which is too small drops messages in code which never asked for a bound. So tellus leaves the choice to us, and the documentation recommends that we make it.

If you want to try this yourself, the [backpressure how-to](https://tellus.rs/docs/how-to/apply-backpressure/) walks through work pulling, and the full [example is on GitHub](https://github.com/tellus-rs/tellus/blob/tellus-v0.4.0/tellus/examples/work_pulling.rs). What do you think about this recommendation? I am looking forward to your comments.

*My thoughts, written with AI assistance.*
