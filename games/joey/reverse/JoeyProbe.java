// Static analysis only: export references and bounded C pseudocode from a local copy.
// @category Joey
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import com.google.gson.GsonBuilder;
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.Reference;

public class JoeyProbe extends GhidraScript {
    private Map<String, Object> functionInfo(Function f) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("address", f.getEntryPoint().toString());
        row.put("name", f.getName());
        row.put("bodyAddressCount", f.getBody().getNumAddresses());
        row.put("external", f.isExternal());
        row.put("thunk", f.isThunk());
        return row;
    }

    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 2) throw new IllegalArgumentException("output-dir targets-tsv [extra-addresses-csv] [verified-entry-addresses-csv]");
        Path out = Paths.get(args[0]);
        Files.createDirectories(out);
        Path cdir = out.resolve("pseudocode");
        Files.createDirectories(cdir);
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("program", currentProgram.getName());
        report.put("imageBase", currentProgram.getImageBase().toString());
        report.put("language", currentProgram.getLanguageID().toString());
        // Optional entries must have been verified against executable bytes, never guessed from a data pointer.
        if (args.length > 3 && !args[3].isEmpty()) {
            for (String entry : args[3].split(",")) {
                Address address = toAddr(entry);
                if (getFunctionAt(address) == null) {
                    disassemble(address);
                    if (createFunction(address, null) == null)
                        throw new IOException("Could not create verified function entry " + entry);
                }
            }
        }
        List<Map<String, Object>> functions = new ArrayList<>();
        FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
        while (iterator.hasNext()) functions.add(functionInfo(iterator.next()));
        report.put("functions", functions);
        LinkedHashSet<Function> seeds = new LinkedHashSet<>();
        List<Map<String, Object>> references = new ArrayList<>();
        List<String> targets = new ArrayList<>(Files.readAllLines(Paths.get(args[1]), StandardCharsets.UTF_8));
        if (args.length > 2 && !args[2].isEmpty()) {
            for (String address : args[2].split(",")) targets.add(address + "\textra-address");
        }
        for (String line : targets) {
            if (line.isBlank()) continue;
            String[] fields = line.split("\t", 2);
            Address target = toAddr(fields[0]);
            if (fields[1].equals("extra-address")) {
                Function own = getFunctionContaining(target);
                if (own != null && !own.isExternal()) seeds.add(own);
            }
            for (Reference ref : getReferencesTo(target)) {
                Function function = getFunctionContaining(ref.getFromAddress());
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("target", target.toString());
                row.put("label", fields[1]);
                row.put("from", ref.getFromAddress().toString());
                row.put("type", ref.getReferenceType().toString());
                row.put("function", function == null ? null : functionInfo(function));
                references.add(row);
                if (function != null && !function.isExternal()) seeds.add(function);
            }
        }
        report.put("references", references);
        // One neighbourhood is enough for the first pass; do not decompile the whole game blindly.
        LinkedHashSet<Function> selected = new LinkedHashSet<>(seeds);
        for (Function function : seeds) {
            for (Function neighbour : function.getCalledFunctions(monitor)) {
                if (selected.size() >= 100) break;
                if (!neighbour.isExternal() && !neighbour.isThunk()) selected.add(neighbour);
            }
        }
        DecompInterface decompiler = new DecompInterface();
        List<Map<String, Object>> exports = new ArrayList<>();
        try {
            if (!decompiler.openProgram(currentProgram)) throw new IOException(decompiler.getLastMessage());
            for (Function function : selected) {
                monitor.checkCancelled();
                if (function.isExternal() || function.isThunk()) continue;
                DecompileResults result = decompiler.decompileFunction(function, 30, monitor);
                Map<String, Object> row = functionInfo(function);
                row.put("completed", result.decompileCompleted());
                row.put("error", result.getErrorMessage());
                List<String> callees = new ArrayList<>();
                for (Function child : function.getCalledFunctions(monitor)) callees.add(child.getEntryPoint().toString());
                row.put("callees", callees);
                if (result.decompileCompleted()) {
                    Path file = cdir.resolve(function.getEntryPoint().toString() + ".c");
                    Files.writeString(file, "/* Ghidra pseudocode; inferred types and unnamed fields require validation. */\n" +
                        result.getDecompiledFunction().getC(), StandardCharsets.UTF_8);
                    row.put("file", file.toString());
                }
                exports.add(row);
            }
        } finally { decompiler.dispose(); }
        report.put("decompiled", exports);
        Files.writeString(out.resolve("ghidra-report.json"),
            new GsonBuilder().setPrettyPrinting().create().toJson(report), StandardCharsets.UTF_8);
        println("Functions=" + functions.size() + "; references=" + references.size() + "; selected=" + exports.size());
    }
}
