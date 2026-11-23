当前的想法目前还不是很成熟，我希望能够利用async、await来表达RTL数字电路之中的时序状态机逻辑
这个想法最早是注意到async-await的语法糖和promise异步设计的底层实现，会把很多时间上不确定的IO事件按照顺序的方式使用代码去表达。
然后转换成底层的链式状态机的方式去处理和IO相关的业务逻辑。在保证业务逻辑清晰的同时也能够兼顾性能和清晰的代码可读性。
但是当前的很多RTL状态机的描述依然存在是手写的阶段。然而可以发现的是在形式上两者在众多的特征上有高度的相似。
RTL状态机不是CPU密集型顺序逻辑的计算，因为这样的密集计算在数字电路上会被高度优化成流水线和脉动阵列，是另外一个全然不同的方向。
状态机处理的最多了就是流程flow和分支等待条件，在某个阶段和状态等待某个条件完成产生pluse信号。大量的逻辑和状态都是分时复用的。

在使用RTL数字逻辑在表达状态机的时候，尽管有很多标准范式，但是在实际工程之中很难去约束，仍然是大量的信号拉来拉去。
判断条件和信号的产生难以组织成规范的形式，耗费大量人力也是难以厘清其中的关系。
特别是大量子状态机嵌套和各种信号的耦合。另外的一点是：当这样的状态机太多也会产生众多的资源浪费。
很多子状态机在逻辑上是天然互斥的，当子状态A开始工作的B必然是不工作的，B开始长期工作的时候，A其实就是死逻辑。
但是软件上的async await的方式构造的状态机天然的避免了这个问题，特别是基于线程栈的异步IO，状态机只是临时变量。
只有在这个状态的时候子状态机才会占用栈上的临时资源，下个状态就会被回收了。数字逻辑无论如何都在那里，语义上没有办法直接表明他们之间的互斥关系。

所以如果能够设计一条基于async await的方式去处理数字逻辑的信号输入输出，是否就可以在保证在逻辑正确的前提下同时能够保证逻辑的清晰规范并且兼具可读性呢？
当然这个只是一个尝试，一个基于typescript的DSL尝试。当我在Typescript之中描述一个信号（Input wire/logic），更像是一个异步的channel, 我不关系他具体是多少值。
就像Rust、C#、Golang之中的异步channel一样。更强调这个channel之中事件到来的时机，比如某个模块done信号的pluse。
哪怕说这个信号是Const的数值比如8'hff, 1'b1这样的数值我可以定义，生成的RTL也是一条assign，或者就是常量。但是对于我来说永远只是一个恒定产生8'hff 1'b1，永远读不完的channel。
所以在这状态机描述之中，每个同步时钟节拍是被隐藏的，且是背景，默认的前提。在以上的设定下，每个节拍都能从const signal之中读取到一个常数。

当前我可以对channel进行简单逻辑计算（与或非，异或，等，不等，大于，小于），因为我不想考虑四则运算的情况，应该把这些计算逻辑外包给systemverilog而不是这个针对状态机的描述语言。
```js
let const_val = Const(8, 0xff); 
let next_cond = msg_valid & !skip & (msg_val == const_var);
// 当我会产生一个新的new_cond channel。

// 使用这个方式判决条件成立，会生成一个ReceivedMsg的状态。
await next_cond.wait(1); 
// LogicStateHint("ReceivedMsg") 是一个标记，标记这个状态在生成的时候是有具体的名字而不是生成一个匿名状态。
LogicStateHint("ReceivedMsg")
```
总结来说我认为信号在这个设计之中是一个类似异步channel的类型，而不是int，string，array这样的数值类型。

上面这个只是简单的单挑步骤的情况。现在再看分支的情况。现在有一个 rg_user_config_do_step_b 的信号。
我需要A步骤之中判断这个用户的寄存器配置，决定是否要做步骤B,如果不做就要直接执行C。
```js
if (await rg_user_config_do_step_b.read()) { 
    LogicStateHint("StepB") do_step_b();
} 
LogicStateHint("StepC");
```
甚至说一个async函数是一个状态机，那么以往在异步函数之中async函数的调用实际上会被等价于状态机的链式嵌套，这个使用方式我认为在这套方法之中也应当是被允许的。

还有一点是这个状态机在状态转移但是应该怎么对外部逻辑产生效用呢？也就是如何产生动作：比如向同步FIFO发送一个message，或者向DFF写入一个数值，向计数器产生一个clear信号。
之前我们说过，async是一个异步函数代表一个状态机的话，那么对于我们的异步函数而言，传入的参数应该是明确的
```js
interface {
    a: Input<...>,
    b: Input<...>,
    send_vld: Output<...>
}
```
需要明确信号的方向，就像我们给golang的协程传递channel的时候需要明确tx rx的方向。Rust的异步channel也是有tx rx的方向。
对于异步函数的调用其实隐含了三个信号：xxxx_start, 以及结束之后的xxx_done信号，还有xxx_result返回数值。

在传统的传统RTL状态机产生信号一般来说有两种形式： state_is_a , state_move_to_a. 一种是行为信号：state_is_a也就是在状态A保持旗舰总是保持有效对外输出信号；
另外一种是动作信号：state_move_to_a只有在状态向A转移的时候产生一排信号。
```js
async function fsm_drive_signal(ports: FsmPorts) {
    LogicStateHint("IDLE");
    await ports.cond_init.wait(1);
    LogicStateHint("SendMsg");
    a_rdy = ports.fifo_a.push(0x00);
    b_rdy = ports.fifo_b.push(0x10);
    await Promise.all([a_rdy, b_rdy])
    LogicStateHint("MsSended");
    await ports.cond_a.wait(1);
    LogicStateHint("StepA");
}
```
在这个状态机之中应到做出约束和限制。在await一个事件完成之后，直到下一个await这一拍的全部操作：这些执行的操作其实应当是在state_move_to_idle，state_move_to_a的这一拍执行。
并且我认为使用move state这一拍进行事件驱动我认为是更加合理的，且统一。我在接受到Init那一刻开始执行发送操作。在SendMsg这个状态期间等待多个异步操作发送的完成。

若要想之前FSP那种 state_out_cond = (state == A || state == B); 其实对于我们而言意义不大，并且时序难以优化，并且表达是很混乱的。
```js
async function fsm_drive_signal(ports: ModulePorts) {
    LogicStateHint("IDLE");
    await ports.cond_a.wait(1);
    LogicStateHint("StepA");
    ports.out_cond.keep(1);
    await ports.cond_b.wait(1);
    LogicStateHint("StepB");
    ports.out_cond.keep(1);
    await ports.cond_c.wait(1);
    LogicStateHint("StepC");
    ports.out_cond.keep(0);
}
```
如果一定要这么写，我认为完全可以调用DFF来操作。keep应该是换成一拍DFF的set数据。这个dff_out_cond.set(1)在move时刻电平拉起来之后和state_out_cond的组合逻辑也正好是同步的。
时序也更好的同时也能和之前的设想完全同意。

* 因此我们需要定义基本原则：实际上state_move是一个明确的动作信号（组合逻辑输出），触发执行我们需要的操作。
但是state_is则是用来判断下一个状态条件是否满足的的状态，这个期间对于生成的RTL而言不应该有动作执行。

对于内部而言：比如说state_move一般来说是来自于内部的`current_state_is_init & cond_init`，并且驱动fifo的vld信号，提供这样一种模块内部的紧凑的时序驱动信号。
在状态进入SendMsg阶段等待完成条件。但是如果需要获取更宽容的时序，则可以在端口上直接加入一层DFF对于状态机的编写而言其实也是无感的。
对于外部模块而言：但是如果我想在一个名为Active期间开启数据收发，也应使用一个active的dff拉起flag给外部驱动而不是直接判断state。