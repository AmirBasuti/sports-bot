import { Bot, InlineKeyboard, webhookCallback } from "grammy";

export interface Env {
  BOT_TOKEN: string;
}

// ⚠️ REPLACE THIS WITH YOUR EXACT GROUP CHAT ID
// It usually starts with a minus sign, e.g., -100123456789
const GROUP_CHAT_ID = "-5215402920"; 

// Helper function to prevent weird characters in names from breaking the HTML format
function escapeHTML(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const bot = new Bot(env.BOT_TOKEN);

    // 1. Handle the user typing the inline query (@YourBotName Futsal...)
    bot.on("inline_query", async (ctx) => {
      const query = ctx.inlineQuery.query;
      if (!query) return;

      await ctx.answerInlineQuery([{
        type: "article",
        id: "create_event",
        title: `Create Event: ${query}`,
        description: "Tap to post this event to the group",
        input_message_content: {
          message_text: `✅ <b>Event created by ${escapeHTML(ctx.from.first_name)}</b>`,
          parse_mode: "HTML"
        }
      }]);
    });

    // 2. Catch the tap and send the REAL interactive message to the group
    bot.on("chosen_inline_result", async (ctx) => {
      const query = escapeHTML(ctx.chosenInlineResult.query);
      const text = `🏅 <b>Event:</b> ${query}\n\n<b>Players:</b>`;
      
      const keyboard = new InlineKeyboard()
        .text("I'm coming ✅", "join")
        .text("I'm not coming ❌", "leave")
        .row() // Puts the next buttons on a new line
        .text("Bring +1 👥", "guest")
        .text("Maybe 🤔", "maybe");

      await ctx.api.sendMessage(GROUP_CHAT_ID, text, { 
        reply_markup: keyboard, 
        parse_mode: "HTML" 
      });
    });

    // 3. The Core Stateless Button Logic
    bot.on("callback_query:data", async (ctx) => {
      try {
        const action = ctx.callbackQuery.data;
        const messageText = ctx.callbackQuery.message?.text;
        const entities = ctx.callbackQuery.message?.entities || [];
        const user = ctx.from;

        if (!messageText) {
          return ctx.answerCallbackQuery("Error: Could not read message text.");
        }

        const playersStartIndex = messageText.indexOf('Players:');
        const header = messageText.substring(0, playersStartIndex + 8); 

// A. Read Current State directly from the message HTML
        let currentPlayers: { id: number, name: string, status: string }[] = [];
        
        for (const entity of entities) {
          // Only look at entities that appear AFTER the word "Players:"
          if (entity.offset > playersStartIndex) {
            let id: number | null = null;
            
            // THE FIX: Telegram can hide the ID in two different ways. We must check both!
            if (entity.type === "text_mention" && entity.user) {
              id = entity.user.id;
            } else if (entity.type === "text_link" && entity.url && entity.url.startsWith("tg://user?id=")) {
              id = parseInt(entity.url.split("=")[1]);
            }

            // If we successfully found a hidden ID, add them to our current state
            if (id !== null) {
              const rawName = messageText.substring(entity.offset, entity.offset + entity.length);
              
              let status = "coming";
              if (rawName.includes(" (+1)")) status = "guest";
              else if (rawName.includes(" (Maybe)")) status = "maybe";
              
              currentPlayers.push({ id, name: rawName, status });
            }
          }
        }

        let listChanged = false;
        
        // Check what this specific user has already clicked
        const isComing = currentPlayers.some(p => p.id === user.id && p.status === "coming");
        const isMaybe = currentPlayers.some(p => p.id === user.id && p.status === "maybe");
        const hasGuest = currentPlayers.some(p => p.id === user.id && p.status === "guest");

        // B. Process the Button Clicks
        if (action === "join") {
          if (!isComing) {
            // Remove "maybe" status if they are upgrading to "coming"
            currentPlayers = currentPlayers.filter(p => !(p.id === user.id && p.status === "maybe"));
            currentPlayers.push({ id: user.id, name: user.first_name, status: "coming" });
            listChanged = true;
            await ctx.answerCallbackQuery("You are on the main list!");
          } else {
            await ctx.answerCallbackQuery("You are already coming!");
          }
        } 
        else if (action === "leave") {
          if (isComing || isMaybe || hasGuest) {
            // Removes the user AND their guest automatically
            currentPlayers = currentPlayers.filter(p => p.id !== user.id);
            listChanged = true;
            await ctx.answerCallbackQuery("You (and your guests) have been removed.");
          } else {
            await ctx.answerCallbackQuery("You weren't on the list anyway!");
          }
        }
        else if (action === "guest") {
          if (hasGuest) {
            await ctx.answerCallbackQuery("You already added a +1!");
          } else {
            currentPlayers.push({ id: user.id, name: `${user.first_name} (+1)`, status: "guest" });
            listChanged = true;
            await ctx.answerCallbackQuery("Your +1 was added to the reserve list!");
          }
        }
        else if (action === "maybe") {
          if (isComing) {
            await ctx.answerCallbackQuery("You are already on the main list!");
          } else if (isMaybe) {
            await ctx.answerCallbackQuery("You are already marked as maybe!");
          } else {
            currentPlayers.push({ id: user.id, name: `${user.first_name} (Maybe)`, status: "maybe" });
            listChanged = true;
            await ctx.answerCallbackQuery("You've been added to the reserve list as Maybe.");
          }
        }

        // C. Rebuild the Message with the 12-Slot Rule and Separator
        if (listChanged) {
          const top12: typeof currentPlayers = [];
          const reserve: typeof currentPlayers = [];
          let comingCount = 0;
          
          for (const p of currentPlayers) {
            if (p.status === "coming") {
              comingCount++;
              if (comingCount <= 12) top12.push(p);
              else reserve.push(p); 
            } else {
              reserve.push(p);
            }
          }

          let newPlayersList = "\n";
          let indexCount = 1;
          
          for (const p of top12) {
            newPlayersList += `${indexCount}. <a href="tg://user?id=${p.id}">${escapeHTML(p.name)}</a>\n`;
            indexCount++;
          }
          
          if (reserve.length > 0) {
            newPlayersList += "----------------\n";
            for (const p of reserve) {
              newPlayersList += `${indexCount}. <a href="tg://user?id=${p.id}">${escapeHTML(p.name)}</a>\n`;
              indexCount++;
            }
          }

          const keyboard = new InlineKeyboard()
            .text("I'm coming ✅", "join")
            .text("I'm not coming ❌", "leave")
            .row()
            .text("Bring +1 👥", "guest")
            .text("Maybe 🤔", "maybe");
          
          // D. CRITICAL FIX: Safe Message Editing (Prevents the Spam Crash)
          try {
            await ctx.editMessageText(`${header}${newPlayersList}`, { 
              reply_markup: keyboard, 
              parse_mode: "HTML" 
            });
          } catch (editError: any) {
            if (editError.description && editError.description.includes("message is not modified")) {
              console.log("Ignored duplicate edit request due to button spamming.");
            } else {
              console.error("Failed to edit message:", editError);
            }
          }
        }
      } catch (globalError) {
        // Fallback catch to ensure the worker NEVER crashes entirely
        console.error("Critical error in callback processing:", globalError);
        await ctx.answerCallbackQuery("Whoops! Too many requests. Please wait a second and try again.");
      }
    });

    return webhookCallback(bot, "cloudflare-mod")(request);
  },
};