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
