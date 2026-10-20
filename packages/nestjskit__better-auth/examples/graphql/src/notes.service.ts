import { randomUUID } from "node:crypto";
import { EventEmitter, on } from "node:events";
import { Injectable } from "@nestjs/common";
import { Field, ID, ObjectType } from "@nestjs/graphql";

@ObjectType()
export class Note {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  text!: string;

  @Field(() => String)
  author!: string;
}

/** Publishes notes in memory to every open subscription. */
@Injectable()
export class NotesService {
  private readonly events = new EventEmitter<{ added: [Note] }>();

  add(text: string, author: string): Note {
    const note = { id: randomUUID(), text, author };
    this.events.emit("added", note);
    return note;
  }

  /**
   * Iterates over the notes added after this call, each as the `[note]`
   * arguments of its event. Returning the iterator removes its listener.
   */
  added(): AsyncIterableIterator<[Note]> {
    return on(this.events, "added") as AsyncIterableIterator<[Note]>;
  }
}
