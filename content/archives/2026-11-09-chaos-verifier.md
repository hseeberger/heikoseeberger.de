+++
title = "Breaking a Rust actor cluster on purpose, and what it taught us"
date = 2026-11-09
path = "2026-11-09-chaos-verifier"
description = "Five nodes, permanent chaos and a verifier: what it checks, and the two bugs it caught."

[taxonomies]
tags = ["rust","actors","tellus"]

[extra]
image = "brand/social-preview.png"
+++

The [tellus](https://tellus.rs) repository comes with a [cluster demo](https://github.com/tellus-rs/tellus/blob/tellus-v0.5.3/tellus-cluster-demo/README.md): five nodes which run forever while a chaos agent keeps breaking them, and a verifier which checks whether the cluster recovers. In one 45-minute run in October, the verifier reported zero violations, its word for a broken promise. Yet 8 of the 5,352 requests it sent to the cluster failed. How can both be true? Let's look at what the verifier checks, and at the two bugs it caught along the way. Both were fixed before tellus 0.4.0, the first release with clustering, so no released version is affected.

Why a demo at all? Our integration tests already start real processes, but they don't cover DNS, restarting containers or a load balancer, and that is exactly where both bugs were. If you want to see the demo first, the [tellus website](https://tellus.rs/#cluster) has a recording.

## The setup

Let's start with what we run. Five nodes live in Docker Compose and find each other through one DNS name. Every cycle, a small shell script does one bad thing: it kills a node, shuts one down gracefully with `SIGTERM`, or cuts two nodes off from the other three. A node which exits or is killed restarts and joins the cluster again. In front of the nodes we put [Caddy](https://caddyserver.com), which spreads HTTP requests over them.

## What the verifier checks

During a fault, the nodes may disagree, and that is correct. The two sides of a partition see different members, and both are right. If we checked all the time, we would report violations for correct behavior. So the verifier waits until the chaos has paused for 30 seconds, and then checks once whether our cluster has recovered.

What do we mean by recovered? Every node is a member of the cluster and sees all five nodes as Up. There is no split brain, that is, no two groups which each think they are the cluster. And every node finds the actors of the others and can message every other node. Here are the first two checks, where we compare the view of each node with the set of all five addresses:

```rust
let expected = views.iter().map(ClusterView::addr).collect::<BTreeSet<_>>();
for view in &views {
    if view.phase != Phase::Member {
        violations.push(format!("{} is {:?}, not a member", view.name, view.phase));
    }

    let up = view.up_addrs();
    if up != expected {
        let missing = expected.difference(&up).collect::<Vec<_>>();
        violations.push(format!("{} does not see {missing:?} as Up", view.name));
    }

    // ...
}
```

Notice that this is plain Rust. Every node serves its cluster state over HTTP, so all we have to do is fetch the five views and compare them. The [full verifier](https://github.com/tellus-rs/tellus/blob/tellus-v0.5.3/tellus-cluster-demo/src/bin/verifier.rs) is on GitHub.

The load balancer is different: it has to keep answering during a fault, so the verifier checks it all the time. It waits half a second after each request completes and then sends the next one. It reports a violation only when requests keep failing for more than five seconds. But it counts every failed request, and that counter explains our puzzle.

## A stale DNS answer

The first bug was a real violation. After a partition, the two nodes on the losing side removed themselves and restarted at almost the same time. One of them looked up the shared DNS name while the other one's container was not running yet, so it saw only four of the five nodes. That should have fixed itself, because a starting node keeps asking DNS. But [tellus-bootstrap-dns](https://docs.rs/tellus-bootstrap-dns) cached the answer, so every lookup returned the same old list. When the verifier checked, that node still had not rejoined. The fix is a single line:

```rust
fn system_resolver() -> Result<TokioResolver, DnsSeedsError> {
    let mut builder = TokioResolver::builder_tokio()?;
    // No response cache: bootstrap polls to see nodes come and go, which a cached answer hides.
    builder.options_mut().cache_size = 0;
    Ok(builder.build()?)
}
```

Caching is fine in general, as long as the answers are fresher than the time we give a node to rejoin.

## The failed requests

Now let's get back to our puzzle. None of the eight failed requests was a violation, because the next request always succeeded, so they only showed up in the counter. So where did they come from? I matched every increase of the counter with the log of the chaos agent. Five of them came right after a kill, three right after a graceful shutdown, and none after a partition.

A kill losing a request is no surprise, but a graceful shutdown should lose nothing. I first suspected the leave code, which I had just reworked, but an older build lost 3 of 3,334 requests, too. The real cause was in the demo: on `SIGTERM`, a node left the cluster, but answered Caddy's health checks with 200 instead of 503 until it exited. So Caddy kept sending it requests, and one arriving right after the exit failed. A killed node fails the same way.

The fix: on `SIGTERM`, a node now enters the `Leaving` phase, and its health check answers 503:

```rust
async fn health(State(state): State<Arc<NodeState>>) -> StatusCode {
    if matches!(state.phase(), Phase::Downed | Phase::Leaving) {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    }
}
```

Then it keeps running for at least five seconds before it exits, so Caddy has time to notice. We also told Caddy to retry a failed request on another node, which covers the kills as well. The [shutdown code](https://github.com/tellus-rs/tellus/blob/tellus-v0.5.3/tellus-cluster-demo/src/bin/node.rs#L117-L149) and the [Caddyfile](https://github.com/tellus-rs/tellus/blob/tellus-v0.5.3/tellus-cluster-demo/Caddyfile) are on GitHub. In a 45-minute run, with Caddy retrying failed attempts, all 5,400 verifier requests succeeded.

The demo stops its worker while it waits, which is fine for a node which only reports its state. For applications serving real requests, report unhealthy, wait for the load balancer, drain requests, then stop actors and leave the cluster, as the [how-to on shutting down gracefully](https://tellus.rs/docs/how-to/shut-down-gracefully/) shows.

So a graceful leave is only half of a graceful shutdown; the load balancer is the other half. And if we tolerate some failures, as our verifier does, we should still count them. Otherwise the tolerance hides exactly this kind of bug.

## What it cannot catch

So does zero violations mean the cluster is correct? Well, no. Our faults are rather clean: we don't simulate flaky networks, one-way link failures, clock skew or overload. And there is one thing I still have to look into. While I recorded the demo, with the terminal UI polling every node, one of 1,552 requests failed. In a 45-minute run without the terminal UI it did not happen again, but I don't know the cause yet.

If you want to try it yourself, `just start-cluster-demo-compose` starts the demo in a tellus checkout, and `just run-cluster-demo-tui` watches it. The explanation of [membership and downing](https://tellus.rs/docs/explanation/membership-and-downing/) describes what the cluster promises. What would you add to the verifier? I am looking forward to your comments.

## Update, 2026-11-10

[cosmir17](https://github.com/cosmir17) found the cause of the failed request, and it was a kill, not the terminal UI. Docker removes a killed container's network interface about 20 milliseconds before its DNS name. If Caddy dials the node in between, the dial hangs for Caddy's default dial timeout of three seconds. But our Caddyfile retries a failed request for two seconds only, so the request fails. Hence the retries cover a kill only when the dial fails fast: 11 of 50 kills aimed at that gap cost a request. With a dial timeout of half a second, none did. The terminal UI made no difference; with it running, all 16,700 requests succeeded. The fix, in [this pull request](https://github.com/tellus-rs/tellus/pull/275), is three lines in the Caddyfile:

```txt
transport http {
    dial_timeout 500ms
}
```

*My thoughts, written with AI assistance.*
