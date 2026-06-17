/*
 * Test content:
 *
 * Feature:
 * Verifies Resource Monitor helper upload prompt memory for the Ask policy.
 *
 * Operation:
 * Creates helper deployment memory for one Host/helper manifest, marks that
 * prompt as in progress, and asks the memory whether another collection tick
 * should open the same prompt again. It then clears the pending prompt and
 * records a cancellation.
 *
 * Expected:
 * While the first dialog is still waiting for user input, the same Host and
 * helper hash are treated as pending so Resource Monitor refresh ticks do not
 * open duplicate dialogs. After the prompt completes, pending is cleared; if
 * the user cancels, later ticks see the canceled state instead.
 */
use nocturne_lib::{
    RemoteResourceTargetArch, RemoteResourceTargetOs, ResourceHelperDeploymentMemory,
    ResourceHelperManifest,
};

#[test]
fn resource_helper_prompt_memory_deduplicates_pending_dialogs() {
    let manifest = ResourceHelperManifest {
        helper_name: "nocturne-resource-monitor-agent".to_string(),
        purpose: "Resource Monitor metrics".to_string(),
        version: "0.1.0".to_string(),
        target_os: RemoteResourceTargetOs::Linux,
        target_arch: RemoteResourceTargetArch::X86_64,
        upload_path: "~/.cache/nocturne/helpers/0.1.0/nocturne-resource-monitor-agent".to_string(),
        sha256: "abc123".to_string(),
        capabilities: vec!["resource.cpu".to_string()],
    };
    let mut memory = ResourceHelperDeploymentMemory::default();

    assert!(memory.record_pending_prompt("host-1", manifest.clone()));
    assert!(!memory.record_pending_prompt("host-1", manifest.clone()));
    assert!(memory.has_pending_prompt("host-1", &manifest));

    memory.clear_pending_prompt("host-1", &manifest);
    assert!(!memory.has_pending_prompt("host-1", &manifest));

    memory.record_canceled_prompt("host-1", manifest.clone());
    assert!(memory.has_canceled_prompt("host-1", &manifest));
}
