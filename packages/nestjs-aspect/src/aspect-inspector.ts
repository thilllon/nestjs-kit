import { Inject, Injectable } from "@nestjs/common";
import { ASPECT_WEAVER } from "./aspect.module-definition";
import type { AdviceKind, Class, JoinPointKind } from "./types";
import type { AspectWeaver } from "./weaver";

/** One advisor of an advised member. */
export interface MemberAdvisor {
  /** Aspect class or `@Advisor` class. */
  readonly type: Class;
  /** Advice method of the aspect; absent for an `@Advisor` class. */
  readonly methodName?: string | symbol;
  /** Advice kind of the aspect method; absent for an `@Advisor` class. */
  readonly kind?: AdviceKind;
  /** Lower runs first. `undefined` is the lowest precedence. */
  readonly order: number | undefined;
}

/** A member the application advises. */
export interface AdvisedMember {
  /** The woven class, as the container registers it. */
  readonly type: Class;
  /** Class whose prototype defines the member. */
  readonly declaringType: Class;
  readonly name: string | symbol;
  readonly kind: JoinPointKind;
  /** In the order the advice runs: the first advisor is the outermost. */
  readonly advisors: readonly MemberAdvisor[];
}

/**
 * Read-only view of what `AspectModule` wove in this application.
 *
 * `AspectModule` exports it globally. It reports the static matches of the
 * weaver: an advisor whose pointcut also has a runtime condition, such as
 * `Pointcut.args`, is listed for every member it may advise. Classes that become
 * known when the application initializes, such as the instance of a factory
 * provider, are listed from `onModuleInit` of `AspectModule` on. An
 * `@Advisor` class is listed once its instance exists. After the application
 * shuts down nothing is advised and nothing is listed.
 */
@Injectable()
export class AspectInspector {
  constructor(@Inject(ASPECT_WEAVER) private readonly weaver: AspectWeaver) {}

  /** The advised members of the application, or those of one class. */
  advisedMembers(type?: Class): AdvisedMember[] {
    const members: AdvisedMember[] = [];
    for (const { method, advisors } of this.weaver.advisedMembers()) {
      if (type !== undefined && method.targetType !== type) {
        continue;
      }
      members.push({
        type: method.targetType,
        declaringType: method.declaringType,
        name: method.name,
        kind: method.kind,
        advisors: advisors.map(({ source, order }) => ({
          type: source.type,
          ...(source.methodName !== undefined && {
            methodName: source.methodName,
          }),
          ...(source.kind !== undefined && { kind: source.kind }),
          order,
        })),
      });
    }
    return members;
  }

  /**
   * The advisors of one member of a class, in the order their advice runs;
   * empty for a member the application does not advise. `kind` selects the
   * getter or the setter of an accessor.
   */
  advisorsOf(
    type: Class,
    name: string | symbol,
    kind: JoinPointKind = "method",
  ): readonly MemberAdvisor[] {
    const member = this.advisedMembers(type).find(
      (candidate) => candidate.name === name && candidate.kind === kind,
    );
    return member?.advisors ?? [];
  }
}
