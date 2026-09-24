import { logError, logTrace } from "../../logging";
import { MsgType } from "../../messages";

// TODO: refactor this out
import { localIdToRemoteId } from "../../view/worldViewMisc";

import { ClientListener, Sp, CombinedController } from "./clientListener";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

enum CmdArgument {
    ObjectReference,
    BaseForm,
    Int,
    String,
}

type CmdName = "additem" | "equipitem" | "placeatme" | "disable" | "markfordelete" | "mp";

// Console commands that run only on this machine: staff may use them, every use is reported to the server's log, and
// anyone else is refused. Only commands whose arguments SkyrimPlatform converts (none, actor values, numbers): for any
// other argument type the wrapper throws before it runs and the command breaks for staff too (ConsoleApi.cpp GetTypedArg)
const LOCAL_AUDITED = [
    "tgm", "tcl", "tfc", "tai", "tcai", "tdetect", "killall", "psb", "caqs",
    "setav", "modav", "forceav", "restoreav", "damageav", "setscale",
];

export class ConsoleCommandsService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.schemas = ConsoleCommandsService.createSchemas();
        this.setupMpCommand();
        this.setupVanilaCommands();
        this.setupLocalAudit();
        this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    }

    // The server says whether this character holds console rights; until it does, local cheats are refused
    private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
        const content = parseCustomPacket(event);
        if (!content || content["customPacketType"] !== "dboConsoleRights") return;
        this.consoleRights = content["allowed"] === true;
    }

    private setupLocalAudit() {
        for (const name of LOCAL_AUDITED) {
            const command = this.sp.findConsoleCommand(name);
            if (command === null) {
                logError(this, `command`, name, `was null in setupLocalAudit`);
                continue;
            }
            command.execute = (...args: unknown[]) => {
                const refId = Number(args[0]) || 0;
                const target = refId === 0x14 ? "player" : refId ? (localIdToRemoteId(refId) || refId).toString(16) : "";
                const shown = args.slice(1).map((a) => String(a));
                sendCustomPacket(this.controller, { customPacketType: "dbo", event: "consoleLocal", args: [name, target, shown] });
                if (!this.consoleRights) this.sp.printConsole("Console commands are for staff.");
                return this.consoleRights;
            };
        }
    }

    private static createSchemas() {
        const schemas = new Map<CmdName, CmdArgument[]>();
        schemas.set("additem", [CmdArgument.ObjectReference, CmdArgument.BaseForm, CmdArgument.Int]);
        schemas.set("equipitem", [CmdArgument.ObjectReference, CmdArgument.BaseForm]);
        schemas.set("placeatme", [CmdArgument.ObjectReference, CmdArgument.BaseForm]);
        schemas.set("disable", [CmdArgument.ObjectReference]);
        schemas.set("markfordelete", [CmdArgument.ObjectReference]);
        schemas.set("mp", [CmdArgument.ObjectReference, CmdArgument.String]);
        return schemas;
    }

    private setupMpCommand() {
        const command = this.sp.findConsoleCommand(" ConfigureUM") || this.sp.findConsoleCommand("test");
        if (command === null) {
            logError(this, "command was null in setupMpCommand");
            return;
        }

        command.shortName = "mp";
        command.execute = this.getCommandExecutor("mp");
    }

    private setupVanilaCommands() {
        logTrace(this, `Setting up vanila commands`);
        this.schemas.forEach((_, commandName) => {
            logTrace(this, `Setting up command`, commandName);
            const command = this.sp.findConsoleCommand(commandName);
            if (command === null) {
                logError(this, `command`, commandName, `was null in setupVanilaCommands`);
                return;
            }
            if (this.nonVanilaCommands.includes(commandName)) {
                logTrace(this, `command`, commandName, ` is non-vanila command`);
                return;
            }
            command.execute = this.getCommandExecutor(commandName);
        });
        logTrace(this, `Vanila commands set up`);
    }

    private getCommandExecutor(commandName: CmdName): (...args: unknown[]) => boolean {
        return (...args: unknown[]) => {
            // TODO: handle possible exceptions in this function
            const schema = this.schemas.get(commandName);
            if (schema === undefined) {
                logError(this, `Schema not found for command`, commandName);
                return false;
            }

            if (args.length !== schema.length && !this.immuneSchema.includes(commandName)) {
                logError(this, `Mismatch found in the schema of`, commandName, `command`);
                return false;
            }
            for (let i = 0; i < args.length; ++i) {
                switch (schema[i]) {
                    case CmdArgument.ObjectReference:
                        args[i] = localIdToRemoteId(parseInt(`${args[i]}`));
                        if (!args[i]) {
                            this.sp.printConsole("no server id for the selected ref");
                            return false;
                        }
                        break;
                }
            }

            for (let i = 0; i < args.length; ++i) {
                if (typeof args[i] !== "string" && typeof args[i] !== "number") {
                    logError(this, `Bad argument type in command`, commandName, `argument index`, i);
                    return false;
                }
            }

            this.controller.emitter.emit("sendMessage", {
                message: {
                    t: MsgType.ConsoleCommand,
                    data: {
                        commandName,
                        args: args as (string | number)[]
                    }
                },
                reliability: "reliable"
            });

            // Meant to be shown to user, not for logging
            this.sp.printConsole("sent");
            return false;
        };
    }

    private consoleRights = false;
    private readonly schemas: Map<CmdName, CmdArgument[]>;
    private readonly immuneSchema = ["mp"];
    private readonly nonVanilaCommands = ["mp"];
}
