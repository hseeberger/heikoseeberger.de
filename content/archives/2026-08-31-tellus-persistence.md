+++
title = "tellus 0.2: event sourcing for actors"
date = 2026-08-31
path = "2026-08-31-tellus-persistence"

[taxonomies]
tags = ["rust","tokio","actors","tellus"]
+++
[tellus](https://github.com/hseeberger/tellus) 0.2 is out, and it brings the first of the two extensions I promised at the end of the [series about its core](https://heikoseeberger.de/2026-08-24-tellus-1/): persistence, in the shape of event-sourced actors, behind the off-by-default `persistence` feature.

Every actor keeps its state in memory. That is what makes it fast, but it is gone when the process terminates. Saving that state is the obvious answer, but every save overwrites the one before it: what survives is a summary, and how we got there is gone.

Instead, an event-sourced actor appends events, immutable facts about what happened, and never overwrites anything. The state is the fold of these events, so we get it back by replaying them after a crash, a restart or a redeployment. And the history is still there to audit, or to answer a question we had not thought of yet.

## Deciding and applying {#Deciding-and-applying}

In [episode 2](https://heikoseeberger.de/2026-08-26-tellus-2/) we saw an actor as a function from the current state plus one incoming to the next state. Event sourcing cuts that function in two: one half decides what happened, the other folds it into the state. The rest of the design follows from that split. Let's look at a counter which outlives the process it runs in:

```rust
impl EventSourced for Counter {
    type Command = Command;
    type Event = Increased;
    type State = u64;
    type Snapshot = Nothing;
    type Error = Infallible;

    fn persistence_id(&self) -> PersistenceId {
        PersistenceId::new("counter", "example").expect("the segments are valid")
    }

    fn init(&self) -> Result<Self::State, Self::Error> {
        Ok(0)
    }

    fn apply(&self, state: Self::State, Increased: Self::Event) -> Self::State {
        state + 1
    }
}
```

`Command` is what we receive, `Event` is what we store, and `State` is what we never store: `Snapshot` is `Nothing` here, so the count is only ever the fold of the `Increased` events over the seed `0`. `apply` is the half of the old function which performs the transition, and it is the only transition there is, taking the state by value and returning the next one, just like `receive`. The other half, deciding, is `handle`:

```rust
fn handle(
    &self,
    _: &ActorContext<Self::Command>,
    incoming: Incoming<Self::Command>,
    _: &Self::State,
) -> Result<Effect<Self>, Self::Error> {
    match incoming {
        Incoming::Message(Command::Increment(reply_to)) => {
            Ok(Effect::persist(Increased).then(move |count| reply_to.reply(*count)))
        }

        Incoming::Message(Command::Stop) => Ok(Effect::stop()),

        Incoming::Terminated(_) => Ok(Effect::none()),
    }
}
```

Here we only get the state by reference, so we cannot change anything; all `handle` does is validate the command against the state and name the events it causes. What it returns is an `Effect`: which events to persist, whether to stop and, via `then`, what to do afterwards.

That continuation deserves a closer look, because `handle` never computes the new count. It hands `reply_to.reply` to `then` and is called back with whatever `apply` produced. Why the detour? Because settling one command runs in a fixed order: we encode the events, append them to the store, apply them only if the append succeeded, and then run the continuations. So a `then` runs only once its events are durable, and it never runs during replay, which is what makes it a safe place for outward-facing actions such as replying or telling another actor.

## Plugging in a store {#Plugging-in-a-store}

Stores are pluggable behind two small traits: `EventStore` with `append` and `read`, and `SnapshotStore` with `save` and `load`, all of them over encoded bytes. tellus 0.2 ships one implementation of both, `PostgresStore` in the new [tellus-persistence-postgres](https://crates.io/crates/tellus-persistence-postgres) crate, which brings its own schema along:

```rust
let store = PostgresStore::new(pool);
store.migrate().await?;

let system = ActorSystem::event_sourced(Counter, Persistence::new(store));
```

`Persistence` is the wiring: an event store, a snapshot store (none unless we set one) and a codec (CBOR unless we set one). The call above spawns the root; a child comes from `ActorContext::spawn_event_sourced`, which takes the same two arguments. Everything else we know from the core, mailboxes, supervision, death watch and termination, works exactly as before.

Writing a store of our own is a small job, except for fencing, which is easy to get subtly wrong. Every append is conditional on the sequence number we expect it to take, and a store which does not reject a stale expectation lets two incarnations of one stream interleave. So tellus ships its contract test suite as a feature of its own, `persistence-tests`, for a backend crate to run against a real server.

## What this buys us {#What-this-buys-us}

The full contract is in [docs/persistence.md](https://github.com/hseeberger/tellus/blob/main/docs/persistence.md); the short version:

- Events of one effect are appended atomically and are durable before they are applied, and a command is completely settled before the next one is taken from the mailbox.
- Effects are at-most-once: appended events are never lost, but a crash between the append and the continuation loses the continuation, just like a `tell`.
- Replay equals live execution: `apply` is pure and total, and `handle` does not run during recovery. The stored events go to `apply`, one by one and in order, exactly as the live actor applied them, so recovery lands on the same state.
- Failures go to supervision as always, and `Restart` recovers by replaying from the store.
- Every stored payload carries a manifest and a schema version outside itself, so we upcast old versions on read instead of migrating the store.

Both examples run against the `postgres` service of the repository's `docker-compose.yaml`: [event_sourced_counter.rs](https://github.com/tellus-rs/tellus/blob/tellus-v0.3.2/tellus-persistence-postgres/examples/event_sourced_counter.rs) picks up counting where the last run left off, and [event_sourced_supervision.rs](https://github.com/tellus-rs/tellus/blob/tellus-v0.3.2/tellus-persistence-postgres/examples/event_sourced_supervision.rs) is the flaky loader from the series, now recovering its count by replay instead of starting over at zero.

*My thoughts, written with AI assistance.*
