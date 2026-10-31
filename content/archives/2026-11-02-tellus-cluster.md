+++
title = "tellus 0.5: the same ActorRef, across machines"
date = 2026-11-02
path = "2026-11-02-tellus-cluster"
draft = true

[taxonomies]
tags = ["rust","actors","tellus"]
+++

Until recently, every actor in [tellus](https://tellus.rs) lived in the same process as the code talking to it. That is no longer necessary: an `ActorRef` can now point to an actor on another machine, and the code which tells it a message does not change. Clustering arrived with tellus 0.4.0 behind the `cluster` feature, and 0.5 builds on it. In this post we look at what a tellus cluster does, how it looks in code, and where its limits are. But first, let's watch one at work, five nodes under permanent chaos:

{{<cast path="casts/cluster-demo.cast" title="tellus-cluster-demo-tui: 5 nodes, chaos on" speed="6" caption="Kills, graceful leaves and partitions, one per cycle, with a verifier checking the cluster in every quiet window. Played at six times the speed."/>}}

## The same API across nodes

With the `cluster` feature, `ActorRef` implements `Serialize` and `Deserialize`. So we can put a reference into a message, typically a `reply_to: ActorRef<Reply>`. The same holds for `ReplyTo`, which `ask` uses. The receiving actor answers the same way, whether the message came from its own process or from another node. We `tell`, `ask` and `watch` remote actors just like local ones. Let's look at how a node of the [clustered actors tutorial](https://tellus.rs/docs/tutorials/clustered-actors/) joins a cluster and registers its device manager under a key:

```rust
async fn manager_node() -> anyhow::Result<()> {
    let (addr, seeds) = node_args()?;
    join_cluster(addr, seeds).await?;

    let system = ActorSystem::new(DeviceManager);
    cluster::register(&Key::new(MANAGER_KEY), system.root())
        .context("registering the device manager")?;
    system
        .terminated()
        .await
        .context("awaiting actor system termination")
}

async fn join_cluster(addr: SocketAddr, seeds: Vec<SocketAddr>) -> anyhow::Result<()> {
    let transport = QuicTransport::dev(addr).context("dev QUIC transport")?;
    cluster::start_endpoint(EndpointConfig::new(addr), transport).context("remoting endpoint")?;
    timeout(
        BOOTSTRAP_TIMEOUT,
        cluster::bootstrap(FixedSeeds::new(seeds), BootstrapConfig::new()),
    )
    .await
    .context("no cluster within the timeout")?
    .context("bootstrapping the cluster")
}
```

Notice that the actor system is the same one we would spawn in a single process. Joining takes two calls: `start_endpoint` opens the QUIC endpoint of the node, and `bootstrap` joins our cluster through the seed addresses. What if there is no cluster yet? Then only the lowest address among the seeds and our own address may form a cluster, once a strict majority of that set reports no cluster. Nodes sharing that set therefore form a single cluster. Any other node can now look up the device manager by its key, and we tell it messages as if it were local. BTW, `QuicTransport::dev` skips certificate checks and only exists behind the `cluster-dev` feature; in production we authenticate every node with mutual TLS. The full example is in the [tellus repository](https://github.com/tellus-rs/tellus/blob/tellus-v0.5.1/tellus/examples/tutorials/clustered/02_remotable_messages.rs).

## Deciding who is gone

Sending messages across the network is the easy part. The hard part is agreeing on who belongs to the cluster, and deciding that a node is gone. Why is that hard? A node which stops answering may have crashed, may be paused, or may be cut off by the network, and from the outside all three look the same. So a tellus cluster does not observe deaths, it decides them.

There is no leader. Every node gossips its member list to the others. The state of a member only moves forward, from Up to Left to Down, so the lists merge in any order. A phi accrual failure detector marks members unreachable, and a pluggable downing provider decides when to remove them. With the default, `KeepMajority`, the side of a partition which sees a majority of the members survives, while the other side downs itself. An even split goes to the side with the member at the lowest address.

Death watch keeps working across nodes, too. When we watch a remote actor and it terminates, the terminated signal still arrives behind every message the actor delivered to us, as the [ordering guarantee](https://tellus.rs/docs/explanation/death-watch-ordering/) promises. When the cluster downs the node of that actor instead, we get a terminated signal which promises that nothing from that node will be delivered again. A downed node never comes back as the same member, either; its restarted process joins as a new incarnation.

## Everything around it

A cluster needs more than membership, so tellus gives us the rest as well:

- A receptionist, where we register actors under typed keys and look them up on any member, and pub-sub on top of it.
- Bootstrap through discovery, with [tellus-bootstrap-dns](https://crates.io/crates/tellus-bootstrap-dns) for DNS records and [tellus-bootstrap-k8s](https://crates.io/crates/tellus-bootstrap-k8s) for the pods of a Kubernetes label selector.
- Mutual TLS, with every certificate bound to the address its node advertises.
- A graceful leave, which announces the departure and tries to drain what the node still has queued before it goes.
- The cluster state as a value, a stream of its changes, and [tellus-cluster-inspect](https://crates.io/crates/tellus-cluster-inspect), an axum router we can mount into our own server.
- Configuration from YAML or any other serde format, with the `serde` feature.

And as a small extra, 0.5 adds timers, opt-in per actor.

## What it does not do

Where are the limits? Gossip costs a frame per member and heartbeat interval, which is fine for tens of nodes, but not yet (optimizations are planned) for hundreds. The majority rule has a price: a cluster of two nodes cannot survive losing the node at the lower address, so a cluster which has to survive one failure needs three nodes. And a partition into more than two sides can leave no survivor at all. What if two members cannot reach each other, but both still reach everyone else? The cluster reports the broken link without downing either node. Messages between them queue up and then become dead letters, asks time out, and watches between them stay silent, until the link heals or an operator downs one of them. The explanation of [membership and downing](https://tellus.rs/docs/explanation/membership-and-downing/) goes through all of this in detail.

## Trying it

The [clustered actors tutorial](https://tellus.rs/docs/tutorials/clustered-actors/) moves the device manager of the getting started tutorial onto a node of its own in five steps. How-tos cover [running on Kubernetes](https://tellus.rs/docs/how-to/run-on-kubernetes/), [shutting down gracefully](https://tellus.rs/docs/how-to/shut-down-gracefully/), [observing a cluster](https://tellus.rs/docs/how-to/observe-a-cluster/) and [securing it with mutual TLS](https://tellus.rs/docs/how-to/secure-with-mutual-tls/). If you want to watch a cluster fail on purpose, `just start-cluster-demo-compose` starts the demo from the recording above in a tellus checkout. Next week I will write about what its verifier checks, and what it caught.

tellus is on [crates.io](https://crates.io/crates/tellus) and [GitHub](https://github.com/tellus-rs/tellus). What do you think about it? I am looking forward to your comments.

*My thoughts, written with AI assistance.*
