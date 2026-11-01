+++
title = "What a chaos verifier checks, and what it caught"
date = 2026-11-09
path = "2026-11-09-chaos-verifier"
draft = true

[taxonomies]
tags = ["rust","actors","tellus"]
+++

The [tellus](https://tellus.rs) repository contains a [cluster demo](https://github.com/tellus-rs/tellus/blob/tellus-v0.5.2/tellus-cluster-demo/README.md): five nodes which run forever while a chaos agent keeps attacking them, and a verifier which holds the cluster to its promises. In one 45 minute run in October, the verifier reported zero violations. In the same run, 8 of the 5,352 requests it sent through the load balancer in front of the cluster failed. How can both be true? In this post I want to show what the verifier checks, why it checks some things only when the chaos pauses and others all the time, and what it caught. Both catches came before tellus 0.4.0, the first release with the cluster, so no released version is affected.

Why such a demo at all? tellus 0.4.0 added clustering, and its integration tests spawn real processes to cover membership scenarios: forming a cluster, joining it, and a partition, simulated by freezing a node with `SIGSTOP`. But they did not exercise the conditions under which we saw the failures in this post: DNS discovery, restarting containers and a load balancer with health checks. If you want to see the demo in action first, the [tellus website](https://tellus.rs/#cluster) has a recording of its terminal UI.

## The setup

Let's start with what we run. Five nodes live in Docker Compose. They find each other through a single DNS name, which Docker resolves to all five addresses, so no node lists the addresses of the others. A chaos agent, a shell script, runs one fault per cycle. It kills a node with `SIGKILL`, sends `SIGTERM` to a node, which then leaves the cluster gracefully, or partitions two nodes off the other three. A node which the cluster has downed exits, and its restart joins the cluster again as a new incarnation. In front of the nodes we put [Caddy](https://caddyserver.com), which load balances their HTTP APIs. The same binaries, the verifier included, also run on Kubernetes in kind, but here we stick to Compose.

## What the verifier checks

During a fault the nodes may disagree, and they should. The two sides of a partition see different members, and both are right. If we checked agreement all the time, we would report violations for correct behavior. So the chaos agent writes the fault it is running into a state file. The verifier checks convergence once per quiet window, after 30 seconds without a fault; the quiet window lasts 45.

What do we expect once the cluster has converged? Every node answers and is a member of the cluster. No two members see disjoint sets of members which are Up, which would be a split brain. Every node sees all five nodes as Up, none as unreachable and no broken link between any two of them. The receptionist of every node, the directory of named actors, resolves all five workers and is settled at the version of the cluster state the node reports. Every node resolves all five subscribers of a pub-sub topic and has recently heard from every node. And every node can message every other one. Here is an excerpt of `verify_cluster`, where we compare the view of each node with the set of all five addresses:

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

    if !view.settlement.settled() || view.settlement.version() != view.state.version() {
        violations.push(format!(
            "{}'s receptionist is not settled at version {}: {:?}",
            view.name,
            view.state.version(),
            view.settlement
        ));
    }
}
```

Notice that these checks are plain Rust over `ClusterState`. Every node gets its cluster state as a value from `cluster::cluster_state` and serves it over HTTP, so all we have to do is fetch the views and compare them. The [full verifier](https://github.com/tellus-rs/tellus/blob/tellus-v0.5.2/tellus-cluster-demo/src/bin/verifier.rs) is on GitHub.

Availability is the opposite. It is exactly the promise which has to hold during a fault, so we check it all the time. The verifier requests `/cluster` through the load balancer, waits 500 milliseconds after each response and requests again. A failed request starts a period of unavailability, and that period becomes a violation only when the failures go on for more than five seconds. A single failed request followed by a successful one is hence no violation. But we count every failed request, and that counter is where our contradiction from the beginning comes from.

## A stale DNS answer

The first catch was a real violation. A quiet window failed, because one of the restarted nodes kept resolving only four of our five addresses. The demo sets `min_peers` to five, and that node did not get past bootstrap.

Both nodes of the minority had downed themselves during a partition and restarted at nearly the same time. One of them resolved the shared DNS name while the container of the other one was not running yet. That alone would have been harmless, because bootstrap polls discovery again and again to notice nodes appearing. But `DnsSeeds` from [tellus-bootstrap-dns](https://docs.rs/tellus-bootstrap-dns) used the default resolver of [hickory](https://docs.rs/hickory-resolver), and that keeps a response cache. So every poll got the same answer until the cached one expired. The fix is a single line:

```rust
fn system_resolver() -> Result<TokioResolver, DnsSeedsError> {
    let mut builder = TokioResolver::builder_tokio()?;
    // No response cache: bootstrap polls to see nodes come and go, which a cached answer hides.
    builder.options_mut().cache_size = 0;
    Ok(builder.build()?)
}
```

Should we never cache in discovery, then? No, a cache is fine as long as its answers are fresh enough for the time we allow bootstrap to take. Here they were not. Polling discovery is only as fresh as the answers it receives.

## The failed requests

Now let's get back to our contradiction. None of the eight failed requests was a violation: each one was followed by a successful request on the next poll. They only showed up in the verifier's count of failed requests, which it reports at `/status` along with the number of requests it has sent. But that count tells us how many requests failed, not when. So where did they come from? Instead of guessing, I polled `/status` every five seconds during a run and noted the time whenever the count went up. Matched against the log of the chaos agent, five of nine kills and three of nine graceful leaves were followed by one failed request each, and no partition was.

A killed node is gone without warning, so a lost request after a kill was no big surprise. A graceful leave, however, should lose nothing, and it had just been reworked, so it was the obvious suspect. But a run of the build from before the rework failed too, 3 of 3,334 requests. So I widened the search beyond the reworked code, and the cause turned out to be in the demo itself. On `SIGTERM`, a node left the cluster as it should, but its `/health` endpoint kept answering 200 until the process exited. Caddy checked the health of the nodes every two seconds and did not retry a failed request on another node. So a request which Caddy routed to the leaving node in that gap failed. A killed node fails the same way, except that it never gets the chance to stop answering 200 first.

We only had to fix the demo. On `SIGTERM`, a node now enters the `Leaving` phase, in which its health check answers 503:

```rust
async fn health(State(state): State<Arc<NodeState>>) -> StatusCode {
    if matches!(state.phase(), Phase::Downed | Phase::Leaving) {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    }
}
```

Then the node keeps running for at least five seconds before it exits. That is longer than Caddy needs to notice, and longer than the readiness probe in the demo's Kubernetes manifests needs, two failed checks two seconds apart. We also gave Caddy `lb_try_duration 2s`, so it retries a failed request on another node. That covers the kills, where no phase and no linger can help. The [shutdown code](https://github.com/tellus-rs/tellus/blob/tellus-v0.5.2/tellus-cluster-demo/src/bin/node.rs#L117-L149) and the [Caddyfile](https://github.com/tellus-rs/tellus/blob/tellus-v0.5.2/tellus-cluster-demo/Caddyfile) are on GitHub. In a run of about 45 minutes of the current demo, with nine kills, nine leaves and nine partitions, none of the verifier's 5,400 requests failed. Notice what that result means, though: with retries, we measure what a client of the load balancer sees, not whether a node dropped a request.

The demo stops its worker and leaves the cluster while it lingers, which is fine for a node whose HTTP API only reports its state. An application serving real requests should follow the [how-to on shutting down gracefully](https://tellus.rs/docs/how-to/shut-down-gracefully/) instead: report unhealthy, linger, drain the requests in flight, and only then stop the actors and leave the cluster.

So leaving a cluster gracefully is only half of a graceful shutdown; the other half is the load balancer. And whenever we tolerate some failures, as our verifier does, we need a counter next to the tolerance, or it hides exactly this kind of failure.

## What it cannot catch

Zero violations is evidence, not proof. Our faults are clean, and we chose the timings so that a recovery fits into the quiet window. Our partitions are symmetric, and we inject no one-way link failures, no clock skew, no slow disks and no overload. On Kubernetes, the partition is a NetworkPolicy, which drops traffic even more cleanly than the packet loss which [pumba](https://github.com/alexei-led/pumba) injects under Compose. And there is a loose end: while I recorded the demo, with the terminal UI polling every node, one request of 1,552 failed. It did not happen again in a 45 minute run without the terminal UI, and I have not looked into it yet. A soak test like this one only finds what its faults can provoke.

If you want to try it yourself, `just start-cluster-demo-compose` starts the demo from a tellus checkout, `just run-cluster-demo-tui` watches it, and `just violations-cluster-demo` lists what the verifier found wanting. The explanation of [membership and downing](https://tellus.rs/docs/explanation/membership-and-downing/) describes what the cluster promises, and the how-to on [observing a cluster](https://tellus.rs/docs/how-to/observe-a-cluster/) shows how to watch your own. What would you add to the verifier? I am looking forward to your comments.

*My thoughts, written with AI assistance.*
