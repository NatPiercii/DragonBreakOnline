# Staff rota and ticket flow (alpha, from 13 October 2026)

A template for Nate to fill in. It uses the roles, channels and tools the server already has. Blanks (`____`) are for
names and times.

## Roles

| Role | Who | In game (admin tier) | Does |
|---|---|---|---|
| Owner | Nate | senior | Decides design, bans, rules and releases; the last word on any ticket |
| Host | Jake | senior | The machines: server up or down, website, backups, network. Staff never restart the host |
| Developer | ____ | developer | Bugs and crashes; reads `/bug` reports and logs; ships fixes through the release process |
| Lead GM | ____ | leadgm | Runs the GM shift; moderation calls; appoints hold officials and faction leaders; can spawn, cannot ban |
| GM | ____, ____ | gm | Answers tickets, watches chat, helps stuck players, keeps RP fair; cannot spawn items or ban |
| Community | ____ | none | Discord announcements, the known-issues page, welcoming new players |

The admin tiers come from Discord roles (`adminRoles` in the server settings). A GM can use the admin panel, but only
Lead GM and above can hand out items, keys, offices and faction leadership. Only developer and senior can ban. Every
panel action lands in the audit log.

**Staff characters are staff-only.** GM and test characters don't play in the alpha world (Nate, 2026-09-30). A staff
member who also plays keeps a separate player character, and never uses the admin panel from it.

## Hours to cover

Players are expected mostly in the European and North American evenings. Aim for someone reachable in each block, and
a GM in game for the two evening blocks.

| Block (UTC) | Covers | Mon | Tue | Wed | Thu | Fri | Sat | Sun |
|---|---|---|---|---|---|---|---|---|
| 08:00-14:00 | Europe daytime, Asia evening | ____ | ____ | ____ | ____ | ____ | ____ | ____ |
| 14:00-20:00 | Europe evening, Americas daytime | ____ | ____ | ____ | ____ | ____ | ____ | ____ |
| 20:00-02:00 | Americas evening (peak) | ____ | ____ | ____ | ____ | ____ | ____ | ____ |
| 02:00-08:00 | Night: tickets wait; on call for outages only | ____ | ____ | ____ | ____ | ____ | ____ | ____ |

Opening week (13-19 Oct): two GMs in each evening block, and a developer reachable from 14:00 to 02:00 UTC.

## Where things land

| What the player does | Where it goes | Who picks it up |
|---|---|---|
| `/bug <what happened>` in game | A thread in **#bug-tracker** on Discord, with a snapshot of the scene (who and what was nearby, the player's position) saved on the server | Developer on shift |
| Posts in the **#bugs** forum | A forum thread | GM triages, then the developer |
| **#create-a-ticket** panel on Discord, or `/ticket pk`, `/ticket mod`, `/ticket report` in game | A private channel under Player Kill Requests, Moderation Help or Player Reports. A ticket from the game carries the character and where they stand; who was nearby goes to the staff channel, never into the ticket | GM on shift |
| Launcher "Report a Problem" | The bug forum, with the launcher log attached | Developer on shift |
| A post in the **#suggestions** forum | A forum thread | Community, then Nate |

`/ticket bug` and `/ticket map` send the player to `/bug`: bugs are not tickets.

## Ticket flow

1. **Acknowledge within 15 minutes** in covered hours, with one or two friendly sentences. No technical detail to the
   player; the detail goes in the staff notes.
2. **Triage** into one of these:
   - Stuck or lost: a GM helps in game (teleport, free a stuck character).
   - Rules and RP: a GM, or the Lead GM if it is serious.
   - Player Kill Request: a GM checks both sides agree.
   - Report Player: the Lead GM.
   - Bug: the developer.
   - Server down: the host.
3. **Act, then reply** in the thread with what was done, in plain words ("taken care of", "fixed in the next update").
4. **Close** the ticket with the Close button when the player is happy or has not answered for 24 hours.
5. **Log** anything that changed a character: items given back, a teleport out of a wall. Write it in the ticket
   channel. The admin panel also writes it to the audit log on its own.

## Escalation

| Situation | First | Then | Then |
|---|---|---|---|
| A player cannot log in or play (several players) | Developer on shift | Nate | Jake if the server or website is down |
| Server down, not answering, or crashing in a loop | Jake (host) | Nate | none |
| A crash or bug hitting many players | Developer | Nate decides on a hotfix | none |
| Exploit, duplication, or item or gold abuse | Lead GM (freeze: take the character aside, collect evidence) | Developer (fix) | Nate (bans, rollbacks) |
| Harassment or rule-breaking | GM | Lead GM | Nate (bans) |
| A request to give back lost items | GM (evidence first: `/bug` snapshot, screenshots) | Lead GM (gives back) | none |

Never do these on shift:
- restart the server, or change server files or settings;
- give items or gold to your own character;
- promise a release date.

Server changes go through the developer and the ops ledger.

## Handover between shifts

At the end of a block, post in the staff channel:
- open tickets, and who has each;
- anything promised to a player;
- incidents (outages, crashes, abuse).

The next shift reads it before taking over.

## Weekly

- Nate, the Lead GM and the developer go through open bugs and the known-issues page.
- The rota for the next week goes up by Friday.
