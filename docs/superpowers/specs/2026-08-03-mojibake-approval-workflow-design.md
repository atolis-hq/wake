# Mojibake Guard and Approval-Gated Workflow Design

## Goal

Keep corrupted UTF-8 text out of committed Wake source and verify a Next workflow that stops after refine until a human posts `/approved` on its GitHub issue.

## Mojibake guard

A repository test scans tracked text source, tests, configuration, and documentation. It rejects the Unicode replacement character and common UTF-8-as-Windows-1252 mojibake prefixes (U+00E2 and U+00C3). Generated output, dependencies, git internals, and binary files are excluded. Existing intentional Unicode must remain valid UTF-8; TypeScript runtime strings use `\u` escapes where an editing path could corrupt them.

## Repair

Repair current malformed source to its intended punctuation and symbols. The guard is introduced after repair so it proves the committed tree contains no corrupted sequences.

## Approval workflow

A second local Next workflow starts with `refine`, then enters a waiting approval stage. A trusted GitHub issue comment exactly matching `/approved` resumes the workflow and permits `implement`. Ordinary comments and unapproved states do not advance it. The workflow follows existing watch/reply semantics rather than creating a GitHub-specific control path.

## Verification

Tests cover the scanner, clean tracked source, workflow suspension, ignored ordinary reply, and `/approved` resume. Live verification creates an assigned issue with the approval workflow, confirms no implement run before the comment, posts `/approved`, and confirms implementation begins.