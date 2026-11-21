+++
title = "Rolling upgrades in tellus: old code cannot learn a new shape"
date = 2026-11-24
path = "2026-11-24-rolling-upgrades"
draft = true
description = "How tellus 0.6 lets old and new nodes of a cluster talk while a message type changes: a schema version on every payload, and new code which bridges both ways."

[taxonomies]
tags = ["rust","actors","tellus"]

[extra]
image = "brand/social-preview.png"
+++

In the [announcement of tellus 0.6](https://heikoseeberger.de/2026-11-20-tellus-0-6/) I promised to show how rolling upgrades look in code. The problem is not special to actors. Whenever an old and a new version of a program exchange data, one of them sees a shape it was not built for. Let's look at how [tellus](https://tellus.rs) deals with that, with the [cluster demo](https://github.com/tellus-rs/tellus/blob/tellus-v0.6.0/tellus-cluster-demo/README.md) as our example. The work started with [an issue by cosmir17](https://github.com/tellus-rs/tellus/issues/261), who asked what happens to a rolling upgrade when a message type changes.

## The problem

During a rolling upgrade, we replace the nodes of a cluster one by one. For a while, old and new nodes run side by side and send each other messages. Now say the new version adds a field to a message. The new nodes send the new shape, and the old nodes still send the old one.

What happens if nobody notices? tellus encodes messages with [postcard](https://docs.rs/postcard), which is compact because it writes no field names, only the values in order. So an old node reading the new shape of a message cannot tell that a field was added. Usually decoding then fails, and the message is lost. Certain type changes are worse: they could decode without any error into a wrong value, for example from `u32` to `i32`, where 7 becomes -4.

## Who can bridge whom?

The key point is this: old code cannot be taught anything. It is already deployed, and it knows only the old shape. So the new code has to bridge both directions. When it receives the old shape, it converts it into the new one, which is called an upcast. When it sends to a node which still runs the old version, it encodes the old shape, a downcast.

But how does a sender know what each peer runs? Every tellus node announces the application version from its configuration, a semantic version, when it connects to another node.

## A schema version on every payload

Every type which we send across nodes implements `cluster::Schema`. Let's look at the trait first, without its documentation:

```rust
pub trait Schema
where
    Self: Serialize + DeserializeOwned,
{
    const VERSION: SchemaVersion = SchemaVersion::new(0);

    fn encode(&self, codec: Codec, peer: &Peer) -> Result<(SchemaVersion, Vec<u8>), CodecError> {
        let _ = peer;
        let payload = codec.encode(self)?;
        Ok((Self::VERSION, payload))
    }

    fn decode(
        codec: Codec,
        schema_version: SchemaVersion,
        payload: &[u8],
    ) -> Result<Self, CodecError> {
        if schema_version == Self::VERSION {
            codec.decode(payload)
        } else {
            let error = UnsupportedSchemaVersion::new::<Self>(schema_version);
            Err(CodecError::make_decoding(error))
        }
    }
}
```

The version travels with every payload. Notice that the defaults encode the current shape as `VERSION` and refuse every other version. What happens to a payload they refuse? It becomes a dead letter with a warning naming the type and both versions, instead of a wrong value. So for a type which never changes, `impl Schema for Greet {}` is all we need. And whenever we change the shape of a type, we bump its `VERSION`.

## Version 0 and version 1 of a pong

Let's look at a type which did change. In our demo, nodes probe each other, and the answer is a `Pong`. The new demo application added a field to it, which says which version of the application the answering node runs:

```rust
struct Pong {
    addr: SocketAddr,
    up_members: usize,
    app_version: Option<String>,
}

struct PongV0 {
    addr: SocketAddr,
    up_members: usize,
}
```

`PongV0` is the old shape, version 0 of the schema, which the old application still sends and expects. Our new application keeps it only for its `Schema`. Here is the downcast, in `encode`:

```rust
const VERSION: SchemaVersion = SchemaVersion::new(1);

fn encode(&self, codec: Codec, peer: &Peer) -> Result<(SchemaVersion, Vec<u8>), CodecError> {
    if peer.app_version().is_none_or(|version| version.major < 2) {
        let view = PongV0 {
            addr: self.addr,
            up_members: self.up_members,
        };
        return Ok((SchemaVersion::new(0), codec.encode(&view)?));
    }
    Ok((Self::VERSION, codec.encode(self)?))
}
```

The `peer` tells us which application version the other node announced. If the peer runs a major version below 2, or we don't know its version, we send version 0 of the pong and leave out the new field. The upcast in `decode` goes the other way:

```rust
if schema_version == SchemaVersion::new(0) {
    let PongV0 { addr, up_members } = codec.decode(payload)?;
    return Ok(Pong {
        addr,
        up_members,
        app_version: None,
    });
}
if schema_version == Self::VERSION {
    return codec.decode(payload);
}
```

Why is the new field an `Option`? Because an old pong becomes a new one without an application version. Every other version is refused, as in the default. The [full code](https://github.com/tellus-rs/tellus/blob/tellus-v0.6.0/tellus-cluster-demo/src/bin/node.rs#L317-L368) is in the demo.

Why do we need the downcast at all, if the upcast already lets new nodes read old pongs? Because with both, a single rollout is enough. We replace the nodes one by one. At every step, a new node reads the old pong and sends the old pong to old nodes. Without the downcast, a new node would send the new shape to old nodes, which cannot read it. Then we would need two rollouts, where the first release learns to read the new shape but still sends only the old one, and the second sends the new one. The downcast also covers a rollback: when we go back to the old release, the new nodes which still run send the returning old nodes the old pong.

## Why `Vec<Pong>` is not a `Schema`

Here is a detail where Rust's type system matters. Say a node wants to send all the pongs it has collected in one message, as a `Vec<Pong>`. `Pong` is a `Schema`, so wouldn't it be handy if `Vec<Pong>` were one too, without any code of ours? tellus could do that with an implementation for `Vec<T>` of any `T` which is a `Schema`. It would be handy, but also wrong. The vector would be encoded as one payload with one version, so the `encode` and `decode` of the elements would never run. A changed `Pong` inside a `Vec<Pong>` would cross the wire unnoticed.

So tellus implements `Schema` only for types whose shape never changes: the primitives, `String`, `()`, `Option` and `Vec` of those, `ActorRef` and `ReplyTo`. A container of our own type needs a type of our own around it, with its own `VERSION`. `Result` is no `Schema` for the same reason, since it holds our own types too. A reply of `Result<T, E>` hence has to be wrapped in a type of the application, usually an enum.

## What it cannot hide

One case remains which we cannot hide. tellus encodes a message when we tell it, not when it is sent. So a message we tell a node before the first connection to it is up is encoded while the peer's version is still unknown, and `app_version` returns `None`. Our `encode` then sends the oldest shape it supports. An old node can read that, but the message carries only the old fields, even when both nodes are new.

## Testing it

How do we know this works? As with the rest of the cluster, we test it in the demo, which [I wrote about](https://heikoseeberger.de/2026-11-09-chaos-verifier/) two weeks ago. Its chaos agent now also rolls all five nodes between application versions 1.0.0 and 2.0.0, one node per pause in the chaos. The verifier knows which version each node runs. So it makes sure that it has checked the cluster at every step of a roll, with one, two, three and four nodes on the version it rolls to, and reports a violation if it missed one. In our runs with upgrades and downgrades, it found no violations.

If you want to read more, the section on [rolling upgrades](https://github.com/tellus-rs/tellus/blob/tellus-v0.6.0/docs/cluster.md#rolling-upgrades) in the cluster documentation has the whole contract. How do you version the messages between your services? I am looking forward to your comments.

*My thoughts, written with AI assistance.*
