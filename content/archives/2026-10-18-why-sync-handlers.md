+++
title = "Why tellus message handlers are synchronous"
date = 2026-10-18
path = "2026-10-18-why-sync-handlers"

[taxonomies]
tags = ["rust","actors","tellus"]
+++
**Updated (2026-10-19)**: Thanks to feedback on [r/rust](https://www.reddit.com/r/rust/comments/1x9vivy/why_tellus_message_handlers_are_synchronous/), the database example now uses `context.pipe_to_self` instead of a hand-spawned Tokio task, which made the pattern look heavier than it is. The same feedback pointed out that tellus has no stash yet, so the costs now mention that, too; [issue #150](https://github.com/tellus-rs/tellus/issues/150) tracks adding one.

In [tellus](https://tellus.rs), `receive` is a plain function, not an `async fn`. I mentioned that briefly in the [first episode](https://heikoseeberger.de/2026-08-24-tellus-1/) of the tellus series, and it is the design decision people ask about most. Most Rust actor libraries, [kameo](https://crates.io/crates/kameo) and [ractor](https://crates.io/crates/ractor) among them, have async message handlers, so why does tellus not? Usually the question comes in a more practical form: how do I call my database then? In this post I make the case for synchronous handlers properly, and of course we will also answer the database question.

## What an actor does {#What-an-actor-does}

Carl Hewitt [defined an actor](https://en.wikipedia.org/wiki/Actor_model#Fundamental_concepts) by what it may do in response to a message. It may send a finite number of messages to other actors, create a finite number of new actors, and designate the behavior to be used for the next message. Let's look at a group actor from the [getting started tutorial](https://tellus.rs/docs/tutorials/getting-started/) which records a temperature reading for one of its devices:

```rust
GroupMessage::Record {
    device_name,
    degrees,
} => {
    let device = devices
        .entry(device_name)
        .or_insert_with(|| context.spawn(Device));
    device.tell(DeviceMessage::Record(degrees));
    Ok(Control::Continue(devices))
}
```

Here we find all three of Hewitt's verbs. `context.spawn` creates an actor for a device we have not seen before, `tell` sends it a `Record` message carrying the degrees, and `Control::Continue(devices)` designates the state for the next message. Then `receive` returns.

But wait, Hewitt speaks of behavior, and we return a state? In tellus the behavior is `receive` applied to the current state, and `receive` itself never changes. So designating the next state designates the next behavior. If we want an actor to behave completely differently from one message to the next, we use an enum as state and let `receive` match on its variants.

Notice what the definition does not contain: a step where the actor pauses halfway through its reaction and waits for something. So the reaction to one message is a unit, and we should treat it as one. A synchronous `receive` is the most literal translation of that definition into Rust I can think of.

## Awaiting in a handler {#Awaiting-in-a-handler}

Why should we care about being literal? Because an `await` inside a handler has to mean something for the actor, and none of the options is pleasant. Let's look at a hypothetical async handler, not the API of any particular library, for a bank account which asks a fraud service before it pays out:

```rust
async fn handle(&mut self, Withdraw(amount): Withdraw) -> Result<(), Rejected> {
    if self.balance < amount {
        return Err(Rejected);
    }
    self.fraud_service.approve(amount).await?;
    self.balance -= amount;
    Ok(())
}
```

While this handler awaits the fraud service, one of two things happens. Either the actor handles no other message until the call returns. Then the account is blocked, but we cannot see that from the outside: it looks alive, its mailbox fills up, and if the fraud service hangs, so does the account. Or the actor handles further messages in the meantime. Then a second `Withdraw` sees the same balance, passes the same check, and both withdrawals go through. Well, that is an overdraft the check was supposed to prevent.

There is a third question lurking: what happens if the actor is stopped while it awaits? The future is dropped at the `await`, the fraud service may have approved the payment, and the balance was never reduced. Whatever the framework does here, we have to know it and code against it, at every `await` in every handler.

With a synchronous `receive`, we do not have to ask any of these questions. The actor handles one message from start to finish, nothing else sees its state in between, and tellus only ever stops or restarts an actor between two messages. In the [second episode](https://heikoseeberger.de/2026-08-26-tellus-2/) we already saw the related property under failure: a `receive` which fails cannot leave a half-updated state behind.

To be fair, async handlers buy something real: we can write I/O in direct style, right where we need it. kameo and ractor are not wrong to make that trade. I just think that for actors, the other side of the trade is worth more.

## Waiting as a message {#Waiting-as-a-message}

So how do we wait for something in a tellus actor? In the actor model, a result we wait for arrives as a later message, and tellus makes that the only way. When an actor asks another one, `context.reply_to` creates a `ReplyTo` which delivers the reply into the asker's own mailbox, converted into its message type. The reply then arrives through `receive` like any other message.

What do we get from that? Waiting becomes part of the state. The query actor from the tutorial asks all devices of a group for their last reading, and its state says exactly what it is waiting for:

```rust
enum QueryState {
    Starting,

    Running {
        pending: HashMap<ActorId, ActorRef<DeviceMessage>>,
        sum: f64,
        count: u32,
        reply_to: ReplyTo<Option<f64>>,
    },
}
```

Each reading we receive removes a device from `pending`. The query also watches every device, so a device which terminates before it answers is removed when its terminated signal arrives. And thanks to the [ordering guarantee](https://heikoseeberger.de/2026-08-27-tellus-3/), that signal proves its reading can no longer come. When `pending` is empty, the query replies and stops. What an async handler would hide in a suspended future is a plain value here, which we can print, match on and test with `TestContext`, without running an actor system.

## Calling a database {#Calling-a-database}

All right, but what if we really need to await, for a database query or an HTTP request? We pipe the future to the actor itself with `context.pipe_to_self`. Here is a sketch, not code from the repo, of an actor which looks up a customer:

```rust
Incoming::Message(Message::Lookup(id)) => {
    let pool = self.pool.clone();
    context.pipe_to_self(
        async move { fetch_customer(&pool, id).await },
        Message::Customer,
    );
    Ok(Control::Continue(state))
}
```

`pipe_to_self` runs the future on its own Tokio task, and meanwhile our actor keeps handling messages. When the result is ready, `Message::Customer` turns it into a message, and `receive` decides what to do with it, knowing exactly what has happened in the meantime. Blocking or CPU-heavy work goes into `tokio::task::spawn_blocking`, whose `JoinHandle` is a future, too, so we pipe it the same way. The how-to [Call async code from an actor](https://tellus.rs/docs/how-to/call-async-code/) shows both in running code.

The strongest evidence that this works is event sourcing. If any actor needs I/O, it is one which persists events, yet in tellus its `handle` is synchronous, too. As we saw in the [persistence post](https://heikoseeberger.de/2026-08-31-tellus-persistence/), `handle` returns an `Effect` which names the events to persist. tellus appends them to the store, applies them to the state and only then runs continuations like a reply. The I/O happens in tellus, outside of our code, and our code stays a function from a command and a state to an effect.

## The costs {#The-costs}

Of course we do not get synchronous handlers for free. A `receive` which blocks occupies a Tokio worker thread until it returns, so we keep it short and move slow work into a task. A `receive` which never returns keeps its actor from stopping, and with it all of its ancestors, because a parent only terminates after its children.

There is also more ceremony. Where an async handler simply awaits, we need an extra message and a state which remembers what we are waiting for. I am convinced that this is a feature rather than a cost, because the state machine was always there; async handlers only hide it in a future. But I admit that it means writing more code. And if an actor must not handle other messages while it waits, it has to buffer them in its state by hand, because tellus has no stash yet. [Issue #150](https://github.com/tellus-rs/tellus/issues/150) tracks adding one.

What about performance? Synchronous handlers avoid allocating and polling a future per message. In the [comparison benchmarks for tellus 0.3.3](https://tellus.rs/tellus/comparison/tellus-v0.3.3/) against kameo and ractor, tellus handles messages between 1.4 and 2.9 times as fast; the [latest run](https://tellus.rs/tellus/comparison/latest/) has the current numbers. But the synchronous handlers are not the only reason: tellus's mailbox is statically typed, while the others erase message types, which costs them an allocation and a dynamic dispatch per message. So these numbers tell us that tellus is fast, not how much of that we owe to synchronous handlers.

If you want to see the patterns from this post in running code, work through the [getting started tutorial](https://tellus.rs/docs/tutorials/getting-started/) or take a look at its [examples on GitHub](https://github.com/tellus-rs/tellus/tree/tellus-v0.3.3/tellus/examples/tutorials/getting_started). What do you think about this approach? I am looking forward to your comments.

*My thoughts, written with AI assistance.*
