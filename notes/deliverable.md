I chose option B because it struck me as the more challenging, ambiguous problem. I think I was also drawn to it because I spent so much time at Desmos thinking about how to help users learn with technology.

# ecological grounding

I started by reading up on some of the studies in this space - how are people thinking about this and measuring it currently? But I still felt disconnected from the experiences of users, so I wanted to find some transcripts of users engaging with LLMs to do work. I had an agent sample some conversations with many turns from the WildChat-1M dataset. The agent looked at random samples of messages in batches, and suggested threads for me to consider. I found that reading these was very valuable:

For example, in the "C heap file block storage" transcript, the user seems to be copy/pasting an assignment into chat and asking the agent to implement it. This user doesn't seem to be interested in engaging with their own understanding. I think things like this are really humbling, and represent the reality of how many users approach educational tools - millions of kids typing "idk" into Khanmigo. Is there anything that we can really do to get this user to engage in a learning process? What is our role in this interaction?

In the "Django event app URLs" transcript, the user is trying to build a functional prototype of an app. They seem to be genuinely interested in building and confirming that the app works, though their level of comprehension about what is happening is pretty low (they tend to just copy/paste errors to the agent).

And finally, in the "ColBERT/RAPTOR RAG design" transcript, the user is showing a lot of awareness of their own understanding and sophistication in learning strategies. This is an autodidact / power user. Hopefully we can stay out of their way, or perhaps notice ways in which our current product is interfering with their approach. For example, this user repeatedly asks the agent to summarize and restate the prompt, probably trying to keep relevant information on top of the context window.

> Let's review how chunking works... after considering both methods...

This is just from digging through ~100 chat transcripts. How incredibly useful, and what variety! If I were engaging with this as a research project, I'd probably spend way more time on just this piece. I'd try to absorb as much as I can of the texture of the problem, starting with concrete transcripts and interactions, and moving up in complexity through descriptive statistics, visualizations and more abstract ways of understanding the problem space.

But the brief was to demonstrate ability to prototype apps, so I felt like I should actually do that.

# design considerations

When embarking on the endeavor of helping people learn with technology, we must understand that such efforts have a long history of failure. I'd point to Audrey Watters' [blog](https://hackeducation.com/), and her book [Teaching Machines](https://teachingmachin.es/), or the work of education historians like [Larry Cuban](https://larrycuban.wordpress.com/). There have been many, many pronouncements about how novel technology would revolutionize education. Most did not pan out, because they started with the technology and then bent education into a shape the technology could solve.

Instead we must start with an appreciation for the incredible complexity and nuance of the teaching and learning process. Our particular technology may have very little to do with the challenge of learning. We may be offering people chat tutors, when what they actually need is a person who [cares about them](https://danmeyer.substack.com/p/five-friends-make-school-matter-to), or a work environment that treats them with dignity.

## user agency and motivation

> humans can become passive observers rather than active learners

> Ensure users grow their capabilities, not just complete tasks

The brief doesn't really speak to the user's agency. What is the user's motivation when they are engaging with the AI system? How do they relate to becoming passive observers? Are they invested in growing their capabilities?

To grow capabilities, we may choose to introduce friction into a task, like asking the user to do certain steps themselves. We may divert the user from the task in order to explore a related topic - to generalize a concept or make a connection. We may ask the user to do some additional work for us to demonstrate their understanding. If the user is coming to us with the sole goal of completing their task, these sorts of diversions will not be well received. How would the "C heap" user react if the agent responded "To ensure that you grow your capabilities, I think it's best if you implement this piece yourself"?

In order to learn, the user has to engage with unfamiliar topics and wade through confusion. Sustained, effortful attention on a learning task requires the user to provide the motivation.

So we can offer the user an invitation, but the user has to opt in.

## learning as a human endeavor

The idea of people interacting with an agent to improve their domain knowledge feels pretty depressing to me... and I think it is likely to feel demotivating to the user as well. One of the main ways we find motivation to learn is through relationships - people who care about us and our learning journey.

Outside our system, users have access to peers, mentors, coworkers, etc. We should keep an eye out for opportunities for human connection. Can our system encourage the user to engage in learning with others?

## consent, surveillance, context

A system that records everything a person does and distills it into artifacts is - in fact if not by intent - a surveillance system. There is a lot of potential for abuse. For example, such an artifact may be used by a company to algorithmically evaluate and fire employees (See Weapons of Math Destruction by Cathy O'Neil).

Interaction with such systems should be elective and explicit: the user opts in, can transparently see the information the system holds about them, and has the ability to choose how they share it, edit it, or delete it.

There is a second-order cost to getting this wrong. The fact that I am having to submit all my LLM transcripts as part of this interview definitely makes me second-guess the way I write my prompts - "does me asking this question to the LLM reflect poorly on me as an engineer?". This is distracting and undermines how I would normally engage with these tools. So we also have to be mindful of the effects of being recorded and observed on the users' behavior and attention.

And finally, we must pay attention to the broader context surrounding the human-AI interaction. A support agent using AI may be getting measured on the speed and throughput of their ticket queue. Such a person is unlikely to want to deepen their understanding. In that context, a system pushing them to grow their capabilities may just make a hostile workplace worse.

# the prototype

I ended up approaching this in two pieces.

## 1. granting the user space for reflection

Imagine you're using an LLM to complete a work task. You're reading the transcript as the agent is chugging along, and you notice something that you don't understand: perhaps a term that is unfamiliar to you or a decision that seems like it comes out of the blue.

I think the current design of many chat interfaces discourages the user from engaging with this moment. Claude's web UI will allow you to "Reply" to text from the thread, but this action inserts the message into the same thread, which interrupts and diverts the agent on this tangent. Often the explanation the agent offers leads to a second or a third thing the user may want to explore. But exploring like this also sacrifices the user's task context. An alternative is manually creating a new thread, but shuttling info back and forth between multiple threads is its own kind of friction. The user and the agent may struggle to re-orient themselves to the initial task, like the user from the RAG transcript who continually attempted to keep themselves and the agent on track via prompts like "let's summarize what we learned so far".

With this interface we are also undermining the agent's ability to attend to the task of improving the user's understanding. The system prompt and context of the main thread are oriented around completing the task, but now we're adding a secondary goal and piling it into the working context. This splits the agent's attention and prevents us from tuning the context and system prompt to the task of addressing the user's understanding.

So the first prototype attempts to ease this tension. We bring up a dedicated reflection thread, which also gives us room to experiment with the agent's context, prompt and tools.

I also notice that these sorts of reflective interactions tend to have a nested nature. In learning about a new concept, I may run into another concept that I don't understand. So the structure is a nested tree of conversations. I spent some time playing around with the UI for traversing down and back up the context stack.

This prototype reveals several opportunities for further exploration:

- how do we surface this feature to the user? I started with a top-level button to control the "reflect" layer, but found myself expecting the options to appear on text selection - a natural signal that the user wants to do something else with the text. For future directions, we could have a supervisor agent monitoring the task thread and suggest points of reflection (Confluence has a functionality where they highlight domain specific terms and abbreviations and offer a "explain this term" functionality). But I think I err on the side of not messing with the users' attention. We don't want to create a Clippy.

- what prompts do we surface to the user? I intuited "I don't understand this" and "Quiz me on my understanding" as well as a free-form question box. There could be others... like "give me some other examples of this" or "prove to me that this is correct".

- how do we help the user navigate the reflection tree? I added some UI for listing the interaction points and descending/ascending transitions (scrolling, etc.). It still feels clunky. We could add the ability to mark the reflection thread as "done" for example, or some tools for shuttling information back up to the parent thread.

## 2. Improving how the agent supports reflection activities

Within a reflection thread, the goal is attending to the user's understanding, rather than just answering the question or completing the task. This warrants a dedicated system prompt, tools and context. In particular, we want the agent to attend to the user's mental model of the domain. Can we provide the agent with some representation of the user's mental model, and would that improve the ways in which the agent interacts with the user?

One of the things I've been exploring in my coding harness work is blending LLMs with symbolic systems.

One way to do this is by creating symbolic representations and asking the agent to interact with them via tools. I explored having the agent create and maintain a [knowledge graph](https://github.com/dlants/edulab/blob/main/packages/frontend/graph.ts#L15). When using tools to interact with the graph, the agent has to model the segmentation of the domain into nodes, the modeling of the relationships between those nodes, and the segmentation of an individual concept into its description, the description of the user's understanding of the concept (and associated evidence), and a score of the user's understanding. We can also constrain how the agent can read the graph - for example by traversing nodes and edges, which forces a certain pattern of attention.

Another way to combine symbolic and neural capabilities is through automation surrounding threads. A while ago I stole this idea from Claude workflows and applied it to my own coding harness. Within this prototype, [runThread](https://github.com/dlants/edulab/blob/main/packages/frontend/thread.ts#L183) exposes an agentic thread as an async function. You provide the system prompt, tools and a yield schema; the thread runs unsupervised and yields structured data. In this case, I use this to iterate the agent's attention over each user utterance.

Opportunities for exploration exposed by this prototype are:

- does this sort of representation actually help the agent attend to the user's understanding, and produce better responses to reflection threads? (for what's "better", see evaluation below)

- can representations like this be used to enable other sorts of interactions? One sketch of this is the "Give me some ideas about what I can explore" prompt. Novices often lack the domain expertise to direct their attention productively. A condensed representation of their domain knowledge may allow the agent to help.

- how do we surface the graph to the user? I opted to show the update transcript and summary under each reflection user message, as a way of encouraging the user to look at the knowledge graph. Does seeing the graph help the user engage with their own understanding, or more effectively direct their learning?

- can the knowledge graph be useful when working with a mentor? From my experience mentoring, I think it would be interesting to see a graph like this generated from a week of my mentee's work. Perhaps it could serve as a conversation starter during a checkin? Or I could edit the graph to lay out the domain I want the mentee to learn about, or modify the descriptions to bring their attention to specific things. This would in turn affect how the agent interacted with the mentee during the week - perhaps guiding them to reflect on specific things I wanted them to look at. The notes section contains references to transcripts the mentee was performing, so perhaps during our weekly meeting I as a mentor could look at the domain graph, find nodes that I deem important that the mentee doesn't seem to have a solid grasp on, and use it as a map to jump to the more relevant transcripts to review.

I am wary of presenting this as a segmented, multi-staged approach - first we derive the graph, then we drive interventions off the graph. I think of these representations as ambiguous and malleable. Historically, knowledge graphs have been very carefully constructed by domain experts to segment the domain, since a software tutor's actions had to be deterministically driven by the graph model (I'm thinking of systems like Carnegie Learning's or Reasoning Mind's). With LLMs, we don't need to do that - here I allowed the LLMs to create the nodes based on the task context, and to loosely attach text to each node. A domain expert may look at such a representation and scoff - "these are not independent concepts, this node should be split up, etc.". However, it doesn't matter how orthogonal the knowledge graph boundaries are if the artifact positively impacts the mentee/mentor relationship, or if it helps the LLM produce better responses to the user. I am also not attached to the knowledge graph representation. Perhaps just a bucket of documents, or even a single document would work just fine. Perhaps instead of edges we just use a vector space embedding. My goal here was to demonstrate the general toolset of fusing symbolic constraints with LLMs.

# evaluation

I think the gold standard would be to have users interact with these systems at work for a prolonged period of time. We could have domain experts evaluate the users on their degree of conceptual growth during the time period. The intervention group would use the modified chat interface, the control group would use traditional AI tooling. It would be interesting to look for gradient effects with respect to overall amount of AI usage, and kind of AI usage (task completion vs reflective). This is of course rather expensive, and the outcome measure - improved domain knowledge - is one that changes very slowly and is expensive to measure accurately.

So we'd probably need to start with some process measures and see if at least we can see some signal there.

## frequency of reflective interactions

We could sample the user's messages and see how often the user is engaging in behavior that is reflective - seeking to improve their understanding, challenging the agent, asking for rationale or proof, etc. The assumption would be that if users are spending more of their time engaging in such activities then their level of domain expertise would grow. In reading some of the literature on this topic I did find this [paper](https://arxiv.org/pdf/2601.20245).

> Among participants who use AI, we find a stark divide in skill formation outcomes between high-scoring interaction patterns (65%-86% quiz score) vs low-scoring interaction patterns (24%-39% quiz score). The high scorers only asked AI conceptual questions instead of code generation or asked for explanations to accompany generated code; these usage patterns demonstrate a high level of cognitive engagement.

This study has many issues:

- small sample size
- novices learning async libraries for the first time
- a single 30min intervention
- no causal directionality (perhaps the people scored better because they're more capable, which also is why they used AI in the way that they did)

so it's weak evidence, but it's a start.

## intervention quality

We could also look at specific messages that the agent produces and evaluate them for quality. When approaching tasks like this I tend to start with quick, direct, subjective iterations and move up in scale of data and level of formality.

A lot of iteration and improvement can happen by just having the team directly working on the project spot check the transcripts. I can tell whether an agent is being useful to a junior software engineer.

Once obvious flaws stop jumping out at the reviewers, we expand to more human raters. So perhaps bringing in senior software engineers from organizations who have experience mentoring juniors. Or expanding into additional domains. Then we could have this group of people look at a larger volume of transcripts and provide feedback on interaction quality.

Once we have this corpus of human ratings, we can see if an AI model with the appropriate prompt can match inter-rater agreement with the human raters. This could expand the volume of transcripts we can rate, and allow us to set up automated improvement loops. This does carry a risk, since AI raters might have the same overall average of agreement, but exhibit a bias in its disagreement with human raters.

When we have a system that does the right thing in individual interactions, we would move to longitudinal studies of user's experiences and domain expertise growth. This is an important step since learning happens at prolonged timelines. With time, novelty wears off, people get bored or annoyed with repetition, and short term gains can wash out. I would return to direct user interviews and observations to identify low hanging fruit; then move up to more formal methods.

# scaling

## domain generalizability

This system doesn't make any assumptions about the user or the domain. However, this doesn't mean that its application to different domains will be uniform. We shouldn't test it on software engineers and then roll it out to support centers based on the engineer's data. It would be important to evaluate the system in multiple domains before assuming that improvements would generalize.

## cost / token efficiency

One major obstacle to scaling would be cost. We are creating many additional threads, and performing more iterations per user utterance. For a software engineer who's using a coding harness it's not a big leap, but for the average Claude web chat user it's a big increase in tokens spent.

The first goal in a project like this is to figure out if there is anything useful that we can do at all - using the highest-quality models, and a large amount of iteration. Once we establish a positive effect, then we can think about improving efficiency while maintaining quality.

I think there's a lot of room to make this more efficient, from using cheaper models, to gating more expensive computation behind cheaper models, to being more efficient with context through summaries or discarding things that are likely not to be relevant.
