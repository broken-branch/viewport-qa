using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;

public static class FakeModelCli {
  private static string Escape(string value) {
    var result = new StringBuilder();
    foreach (char character in value) {
      switch (character) {
        case '\\': result.Append("\\\\"); break;
        case '"': result.Append("\\\""); break;
        case '\n': result.Append("\\n"); break;
        case '\r': result.Append("\\r"); break;
        case '\t': result.Append("\\t"); break;
        default:
          if (character < 0x20) result.Append("\\u" + ((int)character).ToString("x4"));
          else result.Append(character);
          break;
      }
    }
    return result.ToString();
  }

  private static void Reply(string text) {
    Console.Write("{\"text\":\"" + Escape(text) + "\"}");
  }

  private static string JsonArray(string[] values) {
    var encoded = new List<string>();
    foreach (string value in values) encoded.Add("\"" + Escape(value) + "\"");
    return "[" + String.Join(",", encoded.ToArray()) + "]";
  }

  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    string prompt = args.Length == 0 ? "" : args[args.Length - 1];
    if (prompt.Contains("__MODE_EXIT__")) { Reply("this output must not be accepted"); Console.Error.Write("sensitive noise"); return 1; }
    if (prompt.Contains("__MODE_EMPTY__")) return 0;
    if (prompt.Contains("__MODE_GARBAGE__")) { Console.Write("not-json model chatter"); return 0; }
    if (prompt.Contains("__MODE_DUPLICATE_KEY__")) { Console.Write("{\"text\":\"a\",\"text\":\"b\"}"); return 0; }
    if (prompt.Contains("__MODE_SINGLE_KEY__")) { Console.Write("{\"text\":\"single key accepted\"}"); return 0; }
    if (prompt.Contains("__MODE_OVERSIZED__")) { Reply(new String('x', 32768)); return 0; }
    if (prompt.Contains("__MODE_STDERR_SUCCESS__")) { Console.Error.Write("sensitive noise"); Reply("Use min-width: 0."); return 0; }
    if (prompt.Contains("__MODE_ECHO_ARGV__")) {
      Reply("{\"args\":" + JsonArray(args) + ",\"prompt\":\"" + Escape(prompt) + "\"}");
      return 0;
    }
    if (prompt.Contains("__MODE_ENV__")) {
      var names = new List<string>();
      foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
        string name = Convert.ToString(entry.Key);
        if (name.EndsWith("API_KEY", StringComparison.Ordinal)) names.Add(name);
      }
      Reply(JsonArray(names.ToArray()));
      return 0;
    }
    if (prompt.Contains("__MODE_REDACTION__")) { Console.Error.Write(prompt); return 1; }
    Reply("Use min-width: 0.");
    return 0;
  }
}
