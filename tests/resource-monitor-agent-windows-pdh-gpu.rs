/*
 * Test content:
 *
 * Feature:
 * Verifies the standalone `nocturne-resource-monitor-agent` Windows PDH GPU provider
 * normalization logic.
 *
 * Operation:
 * Feeds fixture GPU Engine and GPU Adapter Memory PDH samples for two Windows
 * GPU LUIDs into the helper library without executing PowerShell, `nvidia-smi`,
 * or any external command.
 *
 * Expected:
 * The helper reports one available GPU metric containing both devices,
 * aggregates used / total / free VRAM, averages compute usage across devices,
 * and preserves per-device compute and VRAM details.
 */
use nocturne_resource_monitor_agent::{
    normalize_windows_gpu_pdh_samples_for_test, ResourceMetricKind,
    ResourceMonitorAgentMetricStatus, WindowsGpuAdapterInfo, WindowsGpuPdhSample,
};

#[test]
fn windows_pdh_samples_report_grouped_gpu_devices_without_commands() {
    let metric = normalize_windows_gpu_pdh_samples_for_test(
        vec![
            WindowsGpuPdhSample::memory(
                "luid_0x00000000_0x00012ABC_phys_0_dedicated",
                1024 * 1024 * 1024,
            ),
            WindowsGpuPdhSample::engine(
                "pid_1234_luid_0x00000000_0x00012ABC_phys_0_eng_0_engtype_3D",
                12.5,
            ),
            WindowsGpuPdhSample::engine(
                "pid_5678_luid_0x00000000_0x00012abc_phys_0_eng_1_engtype_Compute_0",
                7.5,
            ),
            WindowsGpuPdhSample::memory(
                "luid_0x00000000_0x00034def_phys_0_dedicated",
                2 * 1024 * 1024 * 1024,
            ),
            WindowsGpuPdhSample::engine("luid_0x00000000_0x00034def_engtype_3D", 40.0),
        ],
        vec![
            WindowsGpuAdapterInfo::new(
                "luid_0x00000000_0x00012abc",
                "NVIDIA RTX",
                4 * 1024 * 1024 * 1024,
            ),
            WindowsGpuAdapterInfo::new(
                "luid_0x00000000_0x00034def",
                "AMD Radeon",
                8 * 1024 * 1024 * 1024,
            ),
        ],
    );

    assert_eq!(metric.metric, ResourceMetricKind::Gpu);
    assert_eq!(metric.status, ResourceMonitorAgentMetricStatus::Available);
    assert_eq!(metric.used, Some(3 * 1024 * 1024 * 1024));
    assert_eq!(metric.total, Some(12 * 1024 * 1024 * 1024));
    assert_eq!(metric.percent, Some(30.0));
    assert_eq!(metric.free, Some(9 * 1024 * 1024 * 1024));
    assert_eq!(metric.gpus.len(), 2);
    assert_eq!(metric.gpus[0].id, "luid_0x00000000_0x00012abc");
    assert_eq!(metric.gpus[0].label, "NVIDIA RTX");
    assert_eq!(metric.gpus[0].compute_percent, 20.0);
    assert_eq!(metric.gpus[0].memory_used, 1024 * 1024 * 1024);
    assert_eq!(metric.gpus[0].memory_total, 4 * 1024 * 1024 * 1024);
    assert_eq!(metric.gpus[1].id, "luid_0x00000000_0x00034def");
    assert_eq!(metric.gpus[1].label, "AMD Radeon");
    assert_eq!(metric.gpus[1].compute_percent, 40.0);
    assert_eq!(metric.gpus[1].memory_used, 2 * 1024 * 1024 * 1024);
    assert_eq!(metric.gpus[1].memory_total, 8 * 1024 * 1024 * 1024);
}
