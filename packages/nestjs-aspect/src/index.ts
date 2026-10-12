// The public entry point.

export {
  type AnnotationOptions,
  createAnnotation,
  isAnnotation,
} from "./annotation";
export { promiseAdapter } from "./advice";
export { AspectModule } from "./aspect.module";
export {
  type AdvisedMember,
  AspectInspector,
  type MemberAdvisor,
} from "./aspect-inspector";
export type {
  AspectModuleOptions,
  AspectReportLevel,
} from "./aspect.module-definition";
export {
  type AdviceDecorator,
  type AdviceResult,
  type AdviceValue,
  After,
  AfterReturning,
  AfterThrowing,
  Advisor,
  type AdvisorType,
  Around,
  Aspect,
  type AsyncGuard,
  Before,
} from "./aspect-decorators";
export {
  AspectConfigurationError,
  AspectNotReadyError,
  AspectUsageError,
} from "./errors";
export {
  DeclareParents,
  type DeclareParentsOptions,
  type IntroductionDecorator,
  introduced,
  isIntroduced,
} from "./introduction";
export {
  type AllShapes,
  type AnyShapes,
  type ArgMatcher,
  type ArgOf,
  type ArgsOf,
  type MethodKeys,
  Pointcut,
  type PointcutFactory,
} from "./pointcut-designators";
export type {
  AccessorGuard,
  Advice,
  AdviceAdapter,
  AdviceKind,
  AndShape,
  Annotation,
  AnnotationLike,
  AnyShape,
  AspectAdvice,
  AspectInstantiation,
  AspectOptions,
  BeanRef,
  Class,
  ClassFilter,
  ClassRef,
  AnyFunction,
  InterceptorContext,
  JoinPoint,
  JoinPointKind,
  JoinPointSignature,
  JoinPointOf,
  MethodInterceptor,
  MethodInvocation,
  MethodMatcher,
  MethodOrClassDecorator,
  MethodRef,
  NestAnnotation,
  OrShape,
  ProceedingJoinPointOf,
  PointcutAdvisor,
  PointcutLike,
  ProceedingJoinPoint,
  ReturnValueAdapter,
  ReturnValueAdapterRegistry,
  Shape,
  ShapeOf,
} from "./types";
