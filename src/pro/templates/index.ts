/**
 * Advanced templates (Pro) — public surface.
 */

export type {
  AdvancedTemplate,
  BasicTemplateShape,
  ExpandContext,
  ExpandResult,
  TemplateCondition,
} from './types';
export { expandAdvancedTemplate } from './expand';
export { isTemplaterAvailable, runThroughTemplater } from './templater';
