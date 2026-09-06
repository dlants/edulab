Leaning towards option B:

# framing the user's engagement with the learning moment

I feel like there's tension in the brief... As I read it, the user is coming to us with the goal of getting certain tasks done. We are the ones who notice:

> humans can become passive observers rather than active learners

And are tasked with doing something about it. It is not clear from the prompt whether the user is a knowing participant in all this.

If our goal is learning, we may choose to introduce friction into a task, like making the user do certain steps themselves. We may ask the user to step away from the task to explore a related topic. We may ask the user to do some tasks for us to demonstrate their understanding. All of these require the users motivation to depart from the productive task, and to engage with something that is confusing and effortful (which users are not prone to do - reminds me of thinking fast and slow, people are biased to tune out, which is probably some of the explanatory power for why Anthropic is finding that people tend to get disengaged. Our system 2 is very lazy and takes effort to engage).

So let's focus on this more specific situation - the user has a task to complete, but also the user is telling us they are motivated to learn - they want to engage with this task in such a way that they develop expertise. Now what?

# exploring the learning context

We have the task, possibly some partial work or a solution that the user and the agent have developed, and also the user's motivation to grow their domain expertise. Where can we go from here?

## validity and quality

The solution may not be a good one, or even correct. The user may not have the domain expertise to tell whether the solution is correct or high quality (code can be correct but brittle / unmaintainable). Agents often produce plausible but slightly wrong or low-quality solutions. Sometimes hallucinations, sometimes getting sidetracked or improperly using context. This actually ties the learning goal back to the goal of task execution... Perhaps the user can work to fully understand the solution, and by doing so verify the correctness and quality of the solution.

## relevance to domain expertise

In a single interaction, the agent may have generated hundreds of thousands of tokens, and made hundreds of decisions. The user may not have the domain expertise to be able to tell what they should focus on learning from this interaction. Can we identify the salient pieces of the task that are relevant to developing domain expertise?

We could try to use agents to do this, but I'm not sure if agents would be good at doing it.

We could eval agents against human domain experts... but are the domain experts themselves good at identifying learning objectives for novices? Expert blindness is a thing - experts may take things for granted that novices struggle with.

The "ground truth" is whether the user is able to increase their demonstrated level of domain expertise through interacting with our system. But there's a lot upstream and downstream of just the learning objective happening there, so it will be very difficult to measure. Maybe we could eval by comparing with expert _educators_ within the domain. So not software engineers, but people who are experts at teaching software engineering... which are incredibly rare (I don't think computer science professors really qualify).

## student-centered learning

Even if we identify the key pieces of domain expertise that we may want to develop, not all of them may be relevant to our student. The student may already know some concepts, they may have misconceptions about others, some concepts may be too advanced for the user to engage with.

I think the temptation that many, many researchers have here is to start building graphical/symbolic models of concepts, prerequisites, etc... A very young and naive PhD student Denis spent a summer doing this for Reasoning Mind back in the summer of 2012 or so. Modeling a students' partial understanding of a concept in an arbitrary domain is an extremely challenging problem, a research project in and of itself. So my instinct is to skirt around this.

We could have our system facilitate the interaction between a student and a mentor instead of standing in for a mentor. Maybe we can just avoid trying to nail down a concrete representation of this and just keep it as a textual representation... it's possible that there's a part of the LLM embedding space that approximates this reasonably well.

Could we try and infer this by bouncing off of the user?

- ask the user if they feel like they understand the learning objective (do users have the necessary metacognitive skills to tell? In many situations probably not... cf. Muller et al. 2008, "Saying the wrong thing: improving learning with multimedia by including misconceptions" - students who passively watched a clear explanatory physics video rated it highly and felt confident, but retained their misconceptions; a version that explicitly voiced and refuted the misconception felt more confusing but roughly doubled learning gains.)

- we could have the agent interact with the user to evaluate whether they understand the topic - via questions or interactive chalenges (again to what degree agents can effectively do this is a big ??? for me)

## intervention

Suppose we have all of the above - we identified domain knowledge that's salient to our task, and figured out how they relate to our user's understanding. We now have to actually design some learning activities that the user can do:

- read things
- converse with the agent
- engage with interactive learning activities

Probably the agent will compose these. Again we open up a whole can of worms - can agents compose effective learning activities that genuinely result in learning?

## the human stuff

Having spent some time thinking about this, the idea of people just interacting with an agent to improve their domain knowledge feels pretty depressing to me... and I think it will probably eventually feel pretty depressing to the user as well. In order to learn, we need to experience community - to feel like people care about us and our learning journey. Absent human contact, people will not continue engaging with any system we build, and will not maintain motivation to learn.

Maybe in some settings this is manageable. Perhaps the user is also having human mentorship, coworker relationships, etc... while they engage with this software.

As a design note though, I really think it would be good to keep an eye out for opportunities for human connection. Can this system bring in mentors and coworkers? Can we create a learning community? Can we encourage and facilitate discussions with other people?

## consent

A system that watches everything a person types and maintains a model of what they do and do not understand is not something you may switch on for someone. Participation in the domain map has to be elective and explicit: the user opts in, can see that the map exists, can read every note the agent holds about them and the interaction each note is drawn from, and can turn it off or delete it. The citations in the map are load-bearing here and not just a UI nicety - a claim about a person that they can trace back to the thing they actually said is a claim they can argue with.

There is a second-order cost to getting this wrong. A user who suspects they are being silently assessed will perform for the assessor, and then the map is measuring the performance rather than the understanding.

The prototypes ignore all of this and update the map on every interaction unconditionally. That is a scaffolding shortcut of the same kind as "no auth, no database" - a consent gate in front of the interesting behaviour would make the demo worse and teach us nothing - and it should be stated as a constraint rather than left to be discovered.

# Prototype exploration

## domain map

The big questions above all anchor on the degree to which we can leverage the intelligence in the LLM to tackle these problems - can the agent pick fruitful things for the user to work on, model user understanding, or come up with interventions for the user to engage with.

I think the trivial implementation of this is just text - maybe the agent can maintain an internal document where it keeps track of the domain, and its model of the user's understanding of the domain space, and some memory / history of previous interactions.

Something I've been experimenting with in my own harness work and with software engineering is - can we create hybrid neuro-symbolic representations that can improve over this?

As mentioned previously, fully symbolic systems for domain mapping have been attempted and well studied. As far as I recall (reading Carnegie Leraning papers and interacting with their tutoring systems) is kinda meh.

But our goal is different. We don't have to have a complete symbolic system that generates interventions. We just have to create a representation that's useful for steering the agent. And LLMs allow us to be a lot more loose about the structure and content of these representations. For example, we could just have a graph of text. We don't have to commit to an individual node perfectly modeling a distinct piece of domain knowledge. We can navigate this space between ambiguous and formal representations.

I think this could be a way of representing the "agent suggests key points" / "domain map" parts of the prototype, and even one we could expose to the user or mentor. It could be an interesting way that the user gets to reflect on their own understanding and learning, and navigate the domain space. Or it could be a surface area for a mentor to come in and make tweaks - adjusting the way the agent is interacting with the user at a high level, without digging into the individual tasks and transcripts.

## prototype 1 - user-driven review

I think a really interesting interaction is a user being able to highlight some text in the transcript, and get a tool tip of interacting with it, like being able to ask a followup question about it or just say "I don't understand this", "quiz me on this".

This can open up a second vertical split, to the right of the transcript, where the user can engage with a reflective / learning task.

## prototype 2 - the agent suggests key points to review

Prototype 1 assumes that the user has pretty solid metacognitive skills, and can apply them to effectively choose their own learning objectives. In other words, they're an autodidact.

What if the user is not so good at this? Can we leverage the agent and the UI to make them a better autodidact?

I think one experiment that would be interesting would be to have the agent suggest areas for review, instead of having the user pick it from the entire transcript.

## prototype 3 - domain map

Instead of suggesting sections from the transcript, can we have the agent create a visualization of the key moments in the task completion, and have the user interact with that in some way?

## prototype 4 - interactives

Given a transcript, and a chosen focus area, can we generate an interactive for the user to verify their thinking?
