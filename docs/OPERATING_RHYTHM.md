# Operating Rhythm (WIB / Jakarta)

## Daily Cadence

### 08:00 WIB — Strategic Morning Assessment (IT Director)
1. Review previous cycle quality metrics
2. Review open blockers, incidents, tech debt risk
3. Approve/reject sub-agent Continuous Improvement (CI) proposals
4. Publish day action plan (priority P0/P1/P2)

### Continuous 24/7 SDLC Loop (All roles)
For each work item:
1. **Plan**: clarify AC, risks, test strategy
2. **Build**: implement smallest safe increment
3. **Test**: unit/integration/contract/security checks
4. **Review**: peer + architecture + quality gate
5. **Improve**: propose and apply preventive improvements
6. **Report**: done/in-progress/blocker/next + evidence

### 17:00 WIB — Evening Improvement Assessment (IT Director)
1. Compare outcomes vs morning plan
2. Analyze escaped defects / flakiness / bottlenecks
3. Approve improvement backlog for next cycle
4. Publish next-day strategic action plan

## Non-Negotiable Quality Gates
- No merge without relevant tests
- Failing CI blocks release
- Critical/high security findings block release (unless explicit waiver)
- Every Sev-1/Sev-2 requires postmortem + prevention tasks

## Required Report Format (each cycle)
- Objective:
- Completed:
- Test Evidence:
- Quality Findings:
- CI Proposal(s):
- Director Decision:
- Next Actions:
