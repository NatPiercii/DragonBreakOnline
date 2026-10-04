'use strict'
// The Trial GM Application questions (Nate, 4 Oct), posted into a new Trial GM Application ticket.
// One message per section: Discord refuses a message over 2000 characters.

const SECTIONS = [
  `# Dragonbreak Online — Game Master Application

Game Masters help maintain a fair, immersive roleplay environment by reviewing reports, resolving disputes, supporting events, and enforcing Dragonbreak Online’s rules and server lore.

We are looking for applicants who demonstrate sound judgment, patience, professionalism, and the ability to remain impartial. Previous staff experience is helpful but does not guarantee acceptance.

Please answer honestly and in your own words.`,

  `## Applicant Information

1. Discord username and Discord ID:
2. Age:
3. Time zone:
4. How long have you been playing Dragonbreak Online?
5. What days and times are you generally available, and how many hours per week could you realistically dedicate to GM duties?
6. List your characters, their positions, and any factions you belong to or lead.
7. Do you currently hold a staff position in another community? If so, describe your responsibilities and time commitment.`,

  `## Experience and Motivation

8. Why do you want to become a Game Master for Dragonbreak Online?
9. Describe any previous moderation, GM, or roleplay leadership experience. If you have none, what relevant skills would you bring?
10. What do you believe a GM’s responsibilities are?
11. How would you balance playing your own characters with your responsibilities as a GM?
12. Describe a time you handled a disagreement or received criticism. What did you do, and what did you learn?`,

  `## Rules and Lore

13. How familiar are you with Elder Scrolls lore and Dragonbreak Online’s server lore? Which areas do you know best?
14. Explain the difference between in-character actions and out-of-character conduct. Give an example of metagaming and powergaming.
15. How would you handle a lore question or rule dispute when you are unsure of the correct answer?
16. Explain your understanding of Dragonbreak Online’s PK rules and why evidence and context matter when reviewing a PK request.
17. Explain what creates a conflict of interest for a GM and when you should step away from a ticket.`,

  `## Scenario Questions

For each scenario, explain what you would do, what evidence you would request, and how you would communicate with the players involved.

18. A close friend or member of your own faction is reported for breaking a rule. They privately ask you to dismiss the report. How do you respond?
19. A player reports a rule violation with a short clip. The accused player claims the clip leaves out important context. How do you review the report?
20. Two players disagree about whether a PK was valid. One demands an immediate decision, while the other becomes hostile in the ticket. How do you handle the situation?
21. A hostage uses an OOC Discord message to tell friends where their character is being held. Those friends arrive in-game to rescue them. How would you assess what happened?`,

  `22. A player submits accusations about another player’s conduct in a different realm and asks you to ban them from Dragonbreak. How would you apply our fresh-start policy?
23. A faction leader claims a casual positive comment from a staff member means their proposed system has official approval. They begin using it in RP. How would you address this?
24. A bug prevents a player from completing a required RP mechanic during an event with potentially fatal consequences for their character. How would you handle the interruption and seek a fair resolution?
25. Another GM makes a decision you believe contradicts the rules. Players ask you to overturn it. What do you do?`,

  `## Events and Player Support

26. Pitch a short Elder Scrolls-themed RP event. Include the premise, opportunities for player choice, and possible outcomes.
27. How would you keep an event fair and engaging without favoring your own character, friends, or faction?
28. How would you help a new player who is struggling with the rules or lore?

## Integrity and Accountability

29. Have you received any warnings, bans, or staff removals in Dragonbreak Online or other communities?
30. Is there anything else the GM team should know when considering your application?`,

  `## Applicant Acknowledgment

By submitting this application, I acknowledge that:

* GM authority must never be used to benefit my characters, friends, or factions.
* I must disclose conflicts of interest and step away from affected cases.
* Private tickets, evidence, staff discussions, and player information must remain confidential.
* Staff information must never be used for an in-character advantage.
* Decisions must follow server rules, available evidence, and the proper review process.
* I am expected to accept feedback, acknowledge mistakes, and remain respectful under pressure.
* Submitting an application does not guarantee acceptance. Selected applicants may be invited to an interview or further assessment.

Do you agree to these expectations?

Discord username:
Date:`,
]

// Consecutive sections share a message while they fit, so the ticket is not eight posts
const LIMIT = 1900
const messages = []
for (const part of SECTIONS) {
  const last = messages[messages.length - 1]
  if (last && last.length + 2 + part.length <= LIMIT) messages[messages.length - 1] = `${last}\n\n${part}`
  else messages.push(part)
}

module.exports = messages
