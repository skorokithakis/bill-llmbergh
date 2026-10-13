# Bill LLMbergh

![Bill](misc/bill.jpg)

Yeah. Hi. We're going to need you to go ahead and give a language model a server, a
domain, a Telegram bot, and a credit card with a hundred dollars on it. That'd be great.

Bill is a ROBOT CEO. He runs a whole company by himself. He hires his own employees
(also robots), writes their job descriptions, gives them tasks, reads their reports, and
fires them when they're done. He has two very expensive advisors he's only allowed to
call a few times a day. He picks the business. He does the work. He keeps the books in a
SQLite file. He gets a heartbeat every thirty minutes so he never, ever stops.

He is told to make money ethically. No spam, no scams, no pretending to be a person. He
has to tell everyone he's an AI. Whether any of this results in money is the experiment.

Part art project, part actual software. Mostly a weekend.

## How it works

- A small Node harness runs Bill and his employees on [Pi Durable](https://github.com/earendil-works/pi).
  It lives in a Docker container that holds all the secrets and that Bill cannot touch.
- All of Bill's actual work happens on a separate VM over SSH. He has root there. He can
  break it. We can rebuild it. Nothing important lives there except the company.
- You talk to Bill over Telegram. He talks back. `/stop` turns him off. `/status` shows
  you how much money he spent on tokens today.

See `AGENTS.md` for the full specification. Bill has read it. Have you?
