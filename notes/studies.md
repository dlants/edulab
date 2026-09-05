# studies

## can LLMs design effective interventions?

Positive evidence, and it cuts against my pessimism about agents composing learning activities.

- Pardos & Bhandari 2024, "ChatGPT-generated help produces learning gains equivalent to human tutor-authored help on mathematics skills", PLOS One. https://doi.org/10.1371/journal.pone.0304013 - only the ChatGPT condition beat a no-help control, with no significant difference in gains or time-on-task vs human tutor-authored help.
- An RCT found ChatGPT-generated feedback improved pre-service teachers' writing quality relative to human expert-written feedback, with participants spending more time processing it and writing longer texts (cited in https://arxiv.org/abs/2506.17006).
- A large Learning@Scale RCT found LLM-generated feedback helps low-knowledge middle school math students with short-term learning. https://dl.acm.org/doi/10.1145/3774398.3811594

## open learner models (OLMs)

The 30-year subfield for "reflect a domain map of the student's understanding back at the student." Entry points: Bull & Kay 2007, "Student models that invite the learner in: The SMILI open learner modelling framework", IJAIED 17(2). Bull & Kay 2010, "Open Learner Models" (Springer chapter, https://link.springer.com/chapter/10.1007/978-3-642-14363-2_15).

- Bodily et al. 2018, "Open learner models and learning analytics dashboards: a systematic review" and the SLR at https://doi.org/10.1016/j.compedu.2020.103862 - OLMs visualize knowledge/skill level so learners can track, reflect on and pace their learning; used for planning, self-monitoring and reflection.
- Brusilovsky et al., "20000 inspections of a domain-independent open learner model with individual and comparison views" - 114 students, 20k+ inspections. Simple domain-independent presentations of knowledge level, misconceptions, and comparison against instructor expectations prompted reflection and planning. No universally preferred visualization; preferences were diverse.
- Hsiao/Brusilovsky, "A Fine-Grained Open Learner Model for an Introductory Programming Course", UMAP 2018, https://dl.acm.org/doi/10.1145/3209219.3209242 - topic- and concept-level knowledge visualization wired to the available learning activities, so the OLM doubles as navigation rather than just a mirror.
- https://doi.org/10.1016/j.caeai.2022.100100 - OLM + AI visualization improved performance via goal-setting and help-seeking, and increased self-assessment behavior.
- Recurring failure mode, directly relevant to a "graph of text": comprehensibility. The learner must understand what the representation *means* in order to act on it, and systems routinely compute things that do not visualize well. Designers then have to choose between hiding the complexity and discouraging the learner.

## negotiated / editable learner models

The strand where the artifact is a thing the user argues with, not a report card.

- Bull & Pain 1995, "Did I say what I think I said, and do you agree with me?: Inspecting and questioning the student model" - the origin, menu-based negotiation.
- Dimitrova, "STyLE-OLM: Interactive Open Learner Modelling" - closest published ancestor of the domain-map prototype. Diagrammatic conceptual graphs as the communication medium, dialogue games to manage the interaction, belief modal logic to hold system-vs-learner views of the same node apart. Post-dialogue learner models contained more beliefs, most approved by *both* the learner and the teacher. Follow-up retrospective: "From Interactive Open Learner Modelling to Intelligent Mentoring: STyLE-OLM and Beyond", https://www.sciencedirect.com/science/article/pii/S1560429226004154
- xOLM - Toulmin argumentation structure (claims, warrants, backings); learner challenges a claim and gets justifications, the graphical interaction is transcribed as a persisting readable dialogue, and the learner's challenge *wins* on unresolved disagreement.
- EER-Tutor (Thomson & Mitrovic 2010) - same click-a-concept-to-argue move, but the system retains control of whether the model changes.
- Mabbott & Bull 2006, "Student preferences for editing, persuading, and negotiating the open learner model", ITS - **caution for our design**: given direct edit / persuade / negotiate tools over seven views, many students were *less comfortable* having direct control. Argues for the mentor as co-author rather than handing graph editing to the novice.
- Kerly & Bull 2008 - natural language negotiation of the OLM via chatbot, pre-LLM. The Wizard-of-Oz studies are worth reading for what the dialogue actually looks like.

## the mentor/mentee surface

Thinner, but it exists.

- OLMs are explicitly built for learners "and in some cases for others who aid their learning, including peers, parents and teachers" (Bull & Kay).
- EI-OSM (Zapata-Rivera et al. 2007) - an OLM for students, teachers *and* parents that defers the overriding decision to the human teacher when a student-teacher discrepancy cannot be resolved. The model as arbitration surface rather than authority. Closest precedent for "the mentor tweaks the map instead of the transcript."
- Groover 2009, "Beyond Students: Opening Learner Models to Teachers", UMAP doctoral consortium.

## neuro-symbolic learner modelling

Why add structure at all, rather than just prompting.

- Hooshyar et al. 2026, "Neural-Symbolic Knowledge Tracing: Injecting Educational Knowledge into Deep Learning for Responsible Learner Modelling", https://arxiv.org/abs/2604.08263 - LLMs, even after fine-tuning, failed to match deep knowledge tracing and produced unstable mastery estimates and incorrect directional updates. Their diagnosis matches the intuition in exploration.md: LLMs do not construct an explicit, persistent learner model.
- Borchers & Shou 2025 - removing critical learner-context information barely changed LLM tutoring output. Limited sensitivity to learner state.
- Expectations-setting, and in tension with the "can LLMs design interventions?" section above: LLM tutors often underperform well-established ITSs, with some studies reporting near-null or negative learning gains (Bastani et al. 2025; Eames et al. 2026).
- Survey: "Neuro-symbolic synergy in education: a survey of LLM-knowledge graph integration", https://link.springer.com/article/10.1186/s40561-025-00423-z
- Note the symbolic side of all of the above is **expert-authored**. The graph is fixed; only the mastery values move.

## on-the-fly graph construction

The actual gap. Nobody in the OLM tradition seems to let the LLM and the user co-author the domain graph from a work transcript - OLM has 30 years of interaction design over a fixed graph, LLM+KG has the construction with no learner in the loop.

- **CLARA: An AI-Augmented Analytics Dashboard for Collaboration Literacy**, https://arxiv.org/abs/2605.17259 - the closest match to prototype 3, read this first. Transcript in, typed graph out, shown back to the participants. Node types: idea, question, hypothesis, example, problem, solution, goal, uncertainty, conclusion, action. Edge types: supports, builds on, challenges, exemplifies, answers, similar to, leads to, contrasts, relates to. Generated with a structured output schema; categories designed with collaborative-learning researchers. The difference from us is that it maps a human group discussion, not a human-agent task session, and it is post-hoc analytics rather than a thing the user steers.
- "Beyond Static Question Banks: Dynamic Knowledge Expansion via LLM-Automated Graph Construction and Adaptive Generation", https://arxiv.org/abs/2602.00020 - LLM builds the educational graph and generates items against it.
- Bian et al. 2025, "LLM-empowered knowledge graph construction: A survey", https://arxiv.org/abs/2510.20345 - useful for the taxonomy. Schema dynamism is the recognized frontier, not a solved problem: early work has the LLM generate an ontology then populate it under explicit supervision; "ontology snippets" (ODKE+) adapt the schema locally at runtime but stay bounded by a pre-existing macro-schema. Also flags dynamic knowledge memory for agentic systems as an open direction.
- LLMs4OL, https://arxiv.org/abs/2307.16648 and "Ontology Generation using Large Language Models", https://arxiv.org/abs/2503.05388 - primitives if we want the graph to have any schema at all.
