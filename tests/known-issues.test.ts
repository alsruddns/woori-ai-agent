import {describe,it,expect} from 'vitest';
import {selectorsMatchKnownIssue} from '../apps/cli/src/service-qa.js';

describe('stable known accessibility selectors',()=>{
 it('matches a registered stable selector within a more specific axe selector',()=>{
  expect(selectorsMatchKnownIssue(['.family-link[target="_blank"][rel="noopener noreferrer"]','.family-link:nth-child(3)'],['.family-link','a[href="/ko"]'])).toBe(true);
 });
 it('does not accept unrelated selectors',()=>{
  expect(selectorsMatchKnownIssue(['.new-widget'],['.family-link'])).toBe(false);
 });
});
