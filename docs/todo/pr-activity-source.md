we have configured github issues as a source/sink and these now trigger wake to start or continue work.

I want the same to happen on PRs. Wake will likely create the PR, but a comment or a review on the pr should resume work and get the agent to make changes, update the pr or reply back to comments in thread. 

this means theres now 2 surfaces for communication. if comments are on the issue, respond on the issue. if comments are on the pr, respond on the pr / or on the specific code comment.

The goal is that once a PR is created, a human can review the pr, give feedback and trigger another round of iteration.

it could also be that the comment is just a question, not a code change.

or they may ask the agent to fix a merge conflict.