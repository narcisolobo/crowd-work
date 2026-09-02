# 1-Pager / Vision Doc — Crowd Work

## Title + One-Line Pitch

> **Crowd Work** — a directory of Los Angeles open mics and comedy shows, kept accurate through automated source-checking and community submissions instead of one person's spreadsheet.

## Problem

LA comics and comedy audiences have no reliable, current source for "what mics and shows are happening." A community-maintained list used to fill this gap, but it collapsed when its sole maintainer took a new job and stopped updating it; the person it was handed off to became ostracized from the community, and the list died with them. The need is proven — it just has no owner right now.

## Solution / Value Proposition

Crowd Work aggregates listings from a curated set of sources (venue sites, Instagram, etc.) checked daily by an automated agent, supplemented by public submissions from anyone. Both feed a single, shared moderation queue — requiring a second, different reviewer to confirm any rejection, with a full archive of what was rejected and why — so accuracy doesn't depend on one person's judgment or availability, and the list can survive a maintainer stepping away.

## Target Audience

Two audiences, one dataset: general LA comedy audiences looking for shows to attend, and LA comics looking for open mics to perform at. The same listings serve both, filtered differently — audience-facing fields (ticket price, lineup) for shows, performer-facing fields (sign-up method, cost to perform, host) for mics.

## Key Features

- Directory of mics and shows, filterable by type, day, and neighborhood or broader LA area (e.g., "Eastside")
- Recurrence-aware listings — weekly or monthly (e.g., "last Thursday") patterns, with one-off exceptions for cancellations or date/venue changes
- Daily agent that checks seed sources for changes; sources graduate from moderated to auto-published once they've proven reliable
- Public submission form for new listings and corrections, open to anyone, always human-reviewed
- Accountable moderation: shared queue, two-reviewer rejection, permanent archive of rejected entries

## Why Now

A prior version of exactly this list existed in the LA comedy scene and was clearly valued — its loss left a validated gap with no current solution. That collapse also points to the specific failure mode to design against: single-point-of-failure moderation. Crowd Work's moderation model (shared queue, two-reviewer rejection, full audit trail) is built from that lesson, not as an afterthought.

## Ask / Next Steps

> Move into implementation planning for the MVP (Astro + Supabase + Vercel), prioritizing the recurrence/exception logic and moderation queue state machine first, since they're the highest-risk and most novel pieces of the system.
