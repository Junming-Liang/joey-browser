// Export analyzed basic-block starts, never treat raw data pointers as code.
// @category Joey
import java.nio.file.*;
import java.util.*;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.block.*;

public class JoeyBlocks extends GhidraScript {
    @Override public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length != 1) throw new IllegalArgumentException("output-entry-file");
        TreeSet<String> addresses = new TreeSet<>();
        BasicBlockModel model = new BasicBlockModel(currentProgram);
        CodeBlockIterator blocks = model.getCodeBlocks(monitor);
        while (blocks.hasNext()) {
            monitor.checkCancelled();
            CodeBlock block = blocks.next();
            for (var address : block.getStartAddresses()) {
                long offset = address.getOffset();
                if (offset >= 0x401000 && offset < 0x5db800 &&
                    currentProgram.getListing().getInstructionAt(address) != null) {
                    addresses.add(address.toString());
                }
            }
        }
        Files.write(Paths.get(args[0]), addresses);
        println("Verified analyzed basic-block starts=" + addresses.size());
    }
}
